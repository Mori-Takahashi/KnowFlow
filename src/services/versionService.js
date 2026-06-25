'use strict';

const crypto = require('crypto');
const axios = require('axios');
const debug = require('debug');

const queries = require('../db/queries');
const socketService = require('./socketService');
const {
  SOCKET_EVENTS,
  VERSION_NOTICE_LEVEL,
  GITHUB_API_BASE_URL,
  VERSION_CHECK_INTERVAL_MS,
  VERSION_CHECK_CACHE_TTL_MS,
  HTTP_TIMEOUT_MS,
  ACTIVITY_KIND,
} = require('../constants');

const log = debug('knowflow:versionService');

// Currently installed version, read from package.json once at module load.
const CURRENT_VERSION = require('../../package.json').version;

// Delay before the very first background check after boot, in milliseconds.
// Short enough to surface a pending update quickly, long enough to keep boot
// snappy and avoid racing the HTTP server start.
const INITIAL_CHECK_DELAY_MS = 5000;

// Max number of commit subjects pulled from a GitHub push payload.
const PUSH_MESSAGES_MAX = 5;

/**
 * Parses a semver-ish string into a [major, minor, patch] number tuple. A
 * leading 'v' is tolerated; only the first three numeric segments are used.
 *
 * @param {string} str -> Version string (e.g. 'v1.2.3' or '1.2.3').
 * @returns {number[]|null} -> Parsed tuple, or null when not parseable.
 */
function parseVersion(str) {
  if (typeof str !== 'string') return null;
  const cleaned = str.trim().replace(/^v/i, '');
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compares two version strings.
 *
 * @param {string} a -> First version.
 * @param {string} b -> Second version.
 * @returns {number} -> -1 if a < b, 0 if equal/unparseable, 1 if a > b.
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * Classifies how big the jump from the current to the latest version is.
 *
 * @param {string} current -> Installed version.
 * @param {string} latest -> Latest available version.
 * @returns {string} -> 'major' | 'minor' | 'patch'.
 */
function classifyUpdate(current, latest) {
  const pc = parseVersion(current);
  const pl = parseVersion(latest);
  if (!pc || !pl) return 'patch';
  if (pl[0] !== pc[0]) return 'major';
  if (pl[1] !== pc[1]) return 'minor';
  return 'patch';
}

/**
 * Factory that returns the version service bound to the settings store. The
 * service polls GitHub releases, tracks the latest version in memory, pushes
 * banner/toast notices over Socket.IO and manages manual announcements.
 *
 * @param {Object} deps -> Dependencies.
 * @param {Object} deps.settingsService -> Settings store (update-check config + state).
 * @returns {Object} -> The version service instance.
 */
function createVersionService({ settingsService }) {
  log('createVersionService called');

  // In-memory cache of the last successful release fetch.
  let releases = [];
  let lastCheckedAt = null;
  let lastError = null;

  /**
   * Records an activity event and pushes it to connected dashboards. Mirrors the
   * recordEvent helper used elsewhere (insertEvent + socket emit).
   *
   * @param {Object} args -> Event fields ({ kind, title, detail, source }).
   * @returns {void}
   */
  function recordEvent(args) {
    const event = queries.insertEvent(args);
    socketService.emitActivityNew(event);
  }

  /**
   * Maps a raw GitHub release object into our compact release shape. Drafts and
   * prereleases are filtered out by the caller; entries without a parseable
   * version are dropped here (returns null).
   *
   * @param {Object} raw -> GitHub release object.
   * @returns {Object|null} -> Normalized release, or null when unparseable.
   */
  function mapRelease(raw) {
    const parsed = parseVersion(raw.tag_name || raw.name || '');
    if (!parsed) return null;
    return {
      tag: raw.tag_name || '',
      version: parsed.join('.'),
      name: raw.name || raw.tag_name || '',
      publishedAt: raw.published_at || null,
      url: raw.html_url || '',
      body: raw.body || '',
    };
  }

  /**
   * Returns the current version status synchronously, derived from the cached
   * releases and the installed version.
   *
   * @returns {Object} -> Status payload consumed by the API and the frontend.
   */
  function getStatus() {
    const cfg = settingsService.getUpdateCheckConfig();
    const latestRelease = releases.length ? releases[0] : null;
    const latestVersion = latestRelease ? latestRelease.version : null;
    const updateAvailable = Boolean(latestVersion) && compareVersions(latestVersion, CURRENT_VERSION) > 0;
    return {
      enabled: cfg.enabled,
      repo: cfg.repo,
      currentVersion: CURRENT_VERSION,
      latestVersion,
      updateAvailable,
      updateLevel: updateAvailable ? classifyUpdate(CURRENT_VERSION, latestVersion) : null,
      latestRelease,
      releases,
      announcements: settingsService.listVersionAnnouncements(),
      lastCheckedAt,
      lastError,
    };
  }

  /**
   * Polls the configured GitHub repository for releases and updates the cache.
   * When a newer release than the installed version appears (and has not been
   * notified yet), records an activity event, emits a version notice and
   * persists the notified version so it is announced only once.
   *
   * Never throws: a failed fetch sets lastError and still returns the status.
   *
   * @param {Object} [options] -> Options.
   * @param {boolean} [options.force=false] -> Bypass the cache TTL.
   * @returns {Promise<Object>} -> Resolves with getStatus().
   */
  async function checkForUpdates({ force = false } = {}) {
    log('checkForUpdates called with: %o', { force });
    const cfg = settingsService.getUpdateCheckConfig();

    if (!cfg.enabled) {
      log('update check disabled, returning status without remote call');
      return getStatus();
    }

    // Serve from the in-memory cache when the TTL window is still valid.
    if (!force && lastCheckedAt != null && Date.now() - lastCheckedAt < VERSION_CHECK_CACHE_TTL_MS) {
      log('serving cached release data');
      return getStatus();
    }

    try {
      const url = `${GITHUB_API_BASE_URL}/repos/${cfg.repo}/releases?per_page=20`;
      const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'knowflow',
      };
      // Private repositories require an authenticated request; without a token
      // GitHub answers 404 (deliberately, to not leak the repo's existence).
      if (cfg.githubToken) {
        headers.Authorization = `Bearer ${cfg.githubToken}`;
      }
      const resp = await axios.get(url, { timeout: HTTP_TIMEOUT_MS, headers });

      const list = Array.isArray(resp.data) ? resp.data : [];
      const mapped = list
        .filter((r) => r && !r.draft && !r.prerelease)
        .map(mapRelease)
        .filter((r) => r != null)
        .sort((a, b) => compareVersions(b.version, a.version));

      releases = mapped;
      lastCheckedAt = Date.now();
      lastError = null;

      const latest = releases.length ? releases[0] : null;
      const updateAvailable = Boolean(latest) && compareVersions(latest.version, CURRENT_VERSION) > 0;

      if (updateAvailable && latest.version !== settingsService.getVersionState().lastNotifiedVersion) {
        log('new version detected: %o', { latest: latest.version, current: CURRENT_VERSION });
        recordEvent({
          kind: ACTIVITY_KIND.INFO,
          title: `Neue Version ${latest.version} verfügbar`,
          detail: `Installiert ist ${CURRENT_VERSION}. Details im Changelog.`,
          source: 'Update-Check',
        });
        const level = classifyUpdate(CURRENT_VERSION, latest.version) === 'patch'
          ? VERSION_NOTICE_LEVEL.PATCH
          : VERSION_NOTICE_LEVEL.RELEASE;
        socketService.emit(SOCKET_EVENTS.VERSION_UPDATE, {
          kind: 'release',
          level,
          version: latest.version,
        });
        settingsService.setVersionState({ lastNotifiedVersion: latest.version });
      }
    } catch (err) {
      lastCheckedAt = Date.now();
      const status = err.response ? err.response.status : null;
      if (status === 404) {
        // GitHub returns 404 for unknown AND for private repos without (valid)
        // token, so the hint covers both causes.
        lastError = `Repository "${cfg.repo}" nicht gefunden (404). Bei privaten Repositories muss `
          + 'in den Update-Einstellungen ein GitHub-Token hinterlegt werden.';
      } else if (status === 401) {
        lastError = 'GitHub-Token ungültig oder abgelaufen (401).';
      } else {
        lastError = `Update-Check fehlgeschlagen: ${err.message}`;
      }
      console.error('[versionService] checkForUpdates failed:', err.message);
    }

    return getStatus();
  }

  /**
   * Stores a manual announcement (used by forks without GitHub releases),
   * records an activity event and emits a version notice. A 'release' level
   * shows as a banner, a 'patch' level as a toast.
   *
   * @param {Object} input -> { level, version, title, body }.
   * @returns {Object} -> The stored announcement.
   * @throws {Error} -> If the level is invalid or the title is empty.
   */
  function announce({ level, version, title, body } = {}) {
    log('announce called with: %o', { level });
    const levelValues = Object.values(VERSION_NOTICE_LEVEL);
    if (!levelValues.includes(level)) {
      throw new Error('Ungültige Art. Erlaubt sind "release" (Banner) oder "patch" (Toast).');
    }
    if (typeof title !== 'string' || !title.trim()) {
      throw new Error('Titel darf nicht leer sein.');
    }

    const announcement = {
      id: crypto.randomUUID(),
      level,
      version: version || '',
      title: title.trim(),
      body: body || '',
      createdAt: Date.now(),
    };
    settingsService.addVersionAnnouncement(announcement);

    recordEvent({
      kind: ACTIVITY_KIND.INFO,
      title: `Ankündigung: ${announcement.title}`,
      detail: announcement.version ? `Version ${announcement.version}` : null,
      source: 'Update-Check',
    });
    socketService.emit(SOCKET_EVENTS.VERSION_UPDATE, { kind: 'announcement', announcement });

    return announcement;
  }

  /**
   * Removes a stored manual announcement by id.
   *
   * @param {string} id -> Announcement id.
   * @returns {boolean} -> True when an entry was removed.
   */
  function removeAnnouncement(id) {
    log('removeAnnouncement called with: %o', { id });
    return settingsService.deleteVersionAnnouncement(id);
  }

  /**
   * Pushes an ephemeral toast for a GitHub push webhook. Extracts up to
   * PUSH_MESSAGES_MAX commit subjects (first line of each message). Not
   * persisted: only emitted live to connected dashboards. No-op when the push
   * carries no commits.
   *
   * @param {Object} payload -> GitHub push webhook body.
   * @returns {void}
   */
  function notifyPush(payload) {
    log('notifyPush called');
    const commits = Array.isArray(payload && payload.commits) ? payload.commits : [];
    const messages = commits
      .map((c) => (c && typeof c.message === 'string' ? c.message.split('\n')[0].trim() : ''))
      .filter((m) => m.length > 0)
      .slice(0, PUSH_MESSAGES_MAX);

    if (messages.length === 0) {
      log('push carried no commit messages, skipping');
      return;
    }

    socketService.emit(SOCKET_EVENTS.VERSION_UPDATE, {
      kind: 'push',
      level: VERSION_NOTICE_LEVEL.PATCH,
      id: crypto.randomUUID(),
      title: 'Neue Änderungen im Repository',
      messages,
      compareUrl: (payload && payload.compare) || null,
    });
  }

  /**
   * Starts the periodic background update check. Runs an initial check shortly
   * after boot, then repeats at VERSION_CHECK_INTERVAL_MS. Both timers are
   * unref'd so they never keep the process alive.
   *
   * @returns {void}
   */
  function startPeriodicCheck() {
    log('startPeriodicCheck called');
    const runSafe = () => {
      checkForUpdates({}).catch((err) => {
        console.error('[versionService] Update-Check fehlgeschlagen:', err.message);
      });
    };
    setTimeout(runSafe, INITIAL_CHECK_DELAY_MS).unref();
    setInterval(runSafe, VERSION_CHECK_INTERVAL_MS).unref();
  }

  return {
    parseVersion,
    compareVersions,
    classifyUpdate,
    checkForUpdates,
    getStatus,
    announce,
    removeAnnouncement,
    notifyPush,
    startPeriodicCheck,
  };
}

module.exports = { createVersionService };
