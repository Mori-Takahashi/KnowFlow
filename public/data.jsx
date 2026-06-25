// Live data loader for the KnowFlow WebUI.
// This file replaces the original mock seed and is responsible for:
//   - Fetching initial state from the REST API
//   - Subscribing to Socket.IO events
//   - Storing the latest state in window.KNOWFLOW_DATA
//   - Notifying React via window.dispatchEvent('knowflow:data-changed') so a
//     top-level effect in app.jsx can force a re-render.

(function () {
  // Initial empty state so components that render before the first fetch do not
  // throw on undefined access.
  window.KNOWFLOW_DATA = {
    TICKETS: [],
    TICKETS_TOTAL: 0,
    TICKETS_COUNTS: { all: 0, done: 0, work: 0, err: 0, rework: 0 },
    HEALTH: [],
    ACTIVITY: [],
    STATS: {
      totalProcessed: 0,
      thisWeek: 0,
      inProgress: 0,
      errors: 0,
      rework: 0,
      knowledgeKb: 0,
    },
    THROUGHPUT: [],
    FUNNEL: [],
    KNOWLEDGE_DOCS: [],
    LAST_UPDATE: Date.now(),
  };

  window.KNOWFLOW_TICKETS_FILTER = { page: 1, filter: 'all', q: '' };
  window.KNOWFLOW_LOG_BUFFER = [];

  function notify() {
    window.KNOWFLOW_DATA.LAST_UPDATE = Date.now();
    window.dispatchEvent(new CustomEvent('knowflow:data-changed'));
  }

  async function fetchJson(url) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.json();
    } catch (err) {
      console.warn('Fetch fehlgeschlagen für', url, err.message);
      return null;
    }
  }

  function ticketKindFromStatus(s) {
    if (s === 'done') return 'ok';
    if (s === 'err') return 'err';
    if (s === 'rework') return 'rework';
    return 'info';
  }

  function mapHealth(payload) {
    if (!payload) return [];
    const order = ['knowflow', 'openwebui', 'jira'];
    return order
      .filter((k) => payload[k])
      .map((k) => {
        const h = payload[k];
        const bars = Array.from({ length: 30 }, () => (h.status === 'warn' ? 'warn' : h.status === 'down' ? 'err' : 'ok'));
        return { ...h, bars };
      });
  }

  function mapActivity(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({
      kind: r.kind,
      id: r.jiraId || null,
      before: r.title,
      after: r.detail ? ' - ' + r.detail : '',
      time: r.age,
    }));
  }

  async function loadAll() {
    const filterState = window.KNOWFLOW_TICKETS_FILTER;
    const params = new URLSearchParams({
      page: String(filterState.page || 1),
      filter: filterState.filter || 'all',
      q: filterState.q || '',
    });

    const [health, ticketsResp, stats, activity, knowledge] = await Promise.all([
      fetchJson('/api/health'),
      fetchJson('/api/tickets?' + params.toString()),
      fetchJson('/api/stats'),
      fetchJson('/api/activity?limit=50'),
      fetchJson('/api/knowledge'),
    ]);

    if (health) {
      window.KNOWFLOW_DATA.HEALTH = mapHealth(health);
    }

    if (ticketsResp) {
      window.KNOWFLOW_DATA.TICKETS = ticketsResp.tickets || [];
      window.KNOWFLOW_DATA.TICKETS_TOTAL = ticketsResp.total || 0;
      window.KNOWFLOW_DATA.TICKETS_COUNTS = ticketsResp.counts || { all: 0 };
      window.KNOWFLOW_DATA.TICKETS_PAGE = ticketsResp.page || 1;
      window.KNOWFLOW_DATA.TICKETS_PER_PAGE = ticketsResp.perPage || 10;
    }

    if (stats) {
      window.KNOWFLOW_DATA.STATS = {
        totalProcessed: stats.totalProcessed,
        thisWeek: stats.thisWeek,
        inProgress: stats.inProgress,
        errors: stats.errors,
        rework: stats.rework,
        knowledgeKb: stats.knowledgeMb,
      };
      window.KNOWFLOW_DATA.THROUGHPUT = stats.throughput || [];
      window.KNOWFLOW_DATA.FUNNEL = stats.funnel || [];
    }

    if (activity) {
      window.KNOWFLOW_DATA.ACTIVITY = mapActivity(activity);
      window.KNOWFLOW_DATA.ACTIVITY_RAW = activity;
    }

    if (knowledge) {
      window.KNOWFLOW_DATA.KNOWLEDGE_DOCS = (knowledge.docs || []).map((d) => ({
        id: d.id,
        title: d.title,
        uuid: d.uuid,
        kbSize: d.kbSize,
        updated: d.updated,
        priority: d.priority,
        status: d.status,
        markdown: d.markdown,
      }));
    }

    notify();
  }

  // Expose a way for the tickets page to update the active filter and reload.
  window.KNOWFLOW_RELOAD_TICKETS = function (next) {
    Object.assign(window.KNOWFLOW_TICKETS_FILTER, next || {});
    return loadAll();
  };

  window.KNOWFLOW_FULL_RELOAD = loadAll;

  // POST helpers for retry + manual sync.
  window.KNOWFLOW_RETRY_TICKET = async function (jiraId) {
    try {
      await fetch('/api/tickets/' + encodeURIComponent(jiraId) + '/retry', { method: 'POST' });
    } catch (err) {
      console.warn('Retry fehlgeschlagen:', err.message);
    }
  };
  window.KNOWFLOW_MANUAL_SYNC = async function () {
    try {
      await fetch('/api/sync', { method: 'POST' });
    } catch (err) {
      console.warn('Sync fehlgeschlagen:', err.message);
    }
  };

  // ----- UI debug mode -----------------------------------------------------
  // The debug endpoints only exist when the server runs with UI_DEBUG=true.
  // We probe /api/debug/status once on load: a 200 means the panel may show.
  window.KNOWFLOW_DEBUG_ENABLED = false;
  window.KNOWFLOW_DEBUG_STATE = null;

  async function initDebug() {
    try {
      const resp = await fetch('/api/debug/status');
      if (!resp.ok) return;
      const data = await resp.json();
      if (data && data.enabled) {
        window.KNOWFLOW_DEBUG_ENABLED = true;
        window.KNOWFLOW_DEBUG_STATE = data;
        notify();
      }
    } catch (_err) {
      // Debug mode off or server unreachable: leave the panel hidden.
    }
  }

  // Trigger a simulated ticket transfer. opts: { jiraId?, speed, failAtStep, errorMessage }.
  window.KNOWFLOW_DEBUG_SIMULATE = async function (opts) {
    try {
      await fetch('/api/debug/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts || {}),
      });
    } catch (err) {
      console.warn('Debug-Simulation fehlgeschlagen:', err.message);
    }
  };

  // Force a service health status. status: 'up'|'warn'|'down'|null (null clears it).
  window.KNOWFLOW_DEBUG_HEALTH = async function (service, status) {
    try {
      const resp = await fetch('/api/debug/health-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, status }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (window.KNOWFLOW_DEBUG_STATE) window.KNOWFLOW_DEBUG_STATE.healthOverrides = data.healthOverrides;
      }
    } catch (err) {
      console.warn('Debug-Health-Override fehlgeschlagen:', err.message);
    }
  };

  // Clear all debug health overrides.
  window.KNOWFLOW_DEBUG_RESET = async function () {
    try {
      await fetch('/api/debug/reset', { method: 'POST' });
      if (window.KNOWFLOW_DEBUG_STATE) window.KNOWFLOW_DEBUG_STATE.healthOverrides = {};
    } catch (err) {
      console.warn('Debug-Reset fehlgeschlagen:', err.message);
    }
  };

  function pushLog(level, source, msg) {
    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const t = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
    window.KNOWFLOW_LOG_BUFFER.unshift({ t, lvl: level, src: source, msg });
    if (window.KNOWFLOW_LOG_BUFFER.length > 200) window.KNOWFLOW_LOG_BUFFER.length = 200;
  }

  // Connect Socket.IO and bind live events.
  function connectSocket() {
    if (typeof io !== 'function') {
      console.warn('Socket.IO Client nicht geladen, Live-Updates deaktiviert.');
      return;
    }
    const socket = io({ transports: ['websocket', 'polling'] });
    window.KNOWFLOW_SOCKET = socket;

    socket.on('connect', () => {
      pushLog('INFO', 'socket', 'Verbunden mit KnowFlow-Server');
      notify();
    });
    socket.on('disconnect', () => {
      pushLog('WARN', 'socket', 'Verbindung zum Server unterbrochen');
      notify();
    });

    socket.on('workflow:update', (payload) => {
      pushLog(
        'INFO',
        'pipeline',
        `Workflow ${payload.jiraId}: [${payload.wf.join(',')}] status=${payload.overallStatus}`,
      );
      // Refresh the ticket list and stats so the dashboard reflects new state.
      loadAll();
    });

    socket.on('activity:new', (payload) => {
      pushLog(
        payload.kind === 'err' ? 'ERROR' : payload.kind === 'warn' ? 'WARN' : 'INFO',
        payload.source ? payload.source.toLowerCase() : 'system',
        payload.title + (payload.detail ? ' - ' + payload.detail : ''),
      );
      // Prepend to activity buffer for an instant feel.
      const event = {
        kind: payload.kind,
        id: payload.jiraId || null,
        before: payload.title,
        after: payload.detail ? ' - ' + payload.detail : '',
        time: 'gerade eben',
      };
      window.KNOWFLOW_DATA.ACTIVITY = [event, ...(window.KNOWFLOW_DATA.ACTIVITY || [])].slice(0, 50);
      notify();
    });

    socket.on('ticket:status', () => {
      loadAll();
    });

    socket.on('health:update', () => {
      fetchJson('/api/health').then((h) => {
        if (h) {
          window.KNOWFLOW_DATA.HEALTH = mapHealth(h);
          notify();
        }
      });
    });
  }

  // Initial load + periodic health refresh.
  // Health is checked once on page load and then only every 30 minutes. The
  // server caches the result for the same window so multiple tabs share one
  // upstream call. Keeping the latency tile fresh is not worth the load on
  // Jira's rate-limited token.
  const HEALTH_REFRESH_MS = 30 * 60 * 1000;
  loadAll();
  initDebug();
  connectSocket();
  setInterval(() => {
    fetchJson('/api/health').then((h) => {
      if (h) {
        window.KNOWFLOW_DATA.HEALTH = mapHealth(h);
        notify();
      }
    });
  }, HEALTH_REFRESH_MS);
})();
