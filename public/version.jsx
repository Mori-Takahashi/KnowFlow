// ============================================================
// Versionsbanner & Update-Check (Frontend)
// ============================================================
// Wird NACH data.jsx und VOR app.jsx geladen. Lädt den Versionsstatus von
// /api/version, hört auf das Socket-Event 'version:update' und rendert oben
// einen Banner (für Releases/Ankündigungen) sowie unten rechts einen Toast-
// Stack (für Patches, Patch-Ankündigungen und ephemere Push-Benachrichtigungen).

(function () {
  // Zuletzt geladener Versionsstatus (vom Server). null bis zur ersten Antwort.
  window.KNOWFLOW_VERSION = null;
  // Ephemere Push-Toasts (kommen per Socket, werden nicht persistiert).
  window.KNOWFLOW_VERSION_TOASTS = [];

  function notify() {
    window.dispatchEvent(new CustomEvent("knowflow:data-changed"));
  }

  // Versionsstatus laden und ein Re-Render auslösen. Fehler werden still
  // geschluckt, damit das Dashboard auch ohne Update-Check funktioniert.
  async function loadVersion() {
    try {
      const resp = await fetch("/api/version");
      if (!resp.ok) return;
      window.KNOWFLOW_VERSION = await resp.json();
      notify();
    } catch (_err) {
      // Update-Check deaktiviert oder Server nicht erreichbar: einfach ignorieren.
    }
  }

  loadVersion();

  // Socket-Listener (window.KNOWFLOW_SOCKET wird in data.jsx gesetzt). Defensiv
  // prüfen, da version.jsx unmittelbar nach data.jsx lädt.
  if (window.KNOWFLOW_SOCKET && typeof window.KNOWFLOW_SOCKET.on === "function") {
    window.KNOWFLOW_SOCKET.on("version:update", function (p) {
      if (p && p.kind === "push") {
        // Ephemerer Push-Toast: vorn einfügen und re-rendern.
        window.KNOWFLOW_VERSION_TOASTS.unshift(p);
        notify();
      } else {
        // Release oder Ankündigung: frischen Status vom Server holen.
        loadVersion();
      }
    });
  }

  // ----- localStorage-Helfer (try/catch-gekapselt) -------------------------
  function lsGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_err) {
      return null;
    }
  }
  function lsSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_err) {
      // localStorage nicht verfügbar (z. B. Private Mode): ignorieren.
    }
  }

  // Banner für ein verfügbares Update einer bestimmten Version.
  window.KNOWFLOW_VERSION_LS = {
    isDismissed: function (version) {
      return lsGet("knowflow.update.dismissed." + version) === "1";
    },
    dismiss: function (version) {
      lsSet("knowflow.update.dismissed." + version, "1");
    },
    // Banner für eine manuelle Ankündigung (per id).
    isAnnounceDismissed: function (id) {
      return lsGet("knowflow.announce.dismissed." + id) === "1";
    },
    dismissAnnounce: function (id) {
      lsSet("knowflow.announce.dismissed." + id, "1");
    },
    // Toasts (Patch-Release oder Ankündigung): nur einmal anzeigen.
    isToastSeen: function (key) {
      return lsGet("knowflow.toast.seen." + key) === "1";
    },
    markToastSeen: function (key) {
      lsSet("knowflow.toast.seen." + key, "1");
    },
  };

  // ----- React-Komponenten -------------------------------------------------

  // Eigener kleiner Re-Render-Hook (useLiveData aus app.jsx ist hier noch nicht
  // verfügbar, da app.jsx erst danach lädt).
  function useVersionRerender() {
    const setTick = React.useState(0)[1];
    React.useEffect(function () {
      const handler = function () {
        setTick(function (t) {
          return t + 1;
        });
      };
      window.addEventListener("knowflow:data-changed", handler);
      return function () {
        window.removeEventListener("knowflow:data-changed", handler);
      };
    }, []);
  }

  function formatDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString("de-DE", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (_err) {
      return iso;
    }
  }

  // Modal mit dem vollständigen Changelog (Releases + manuelle Ankündigungen).
  function ChangelogModal({ status, onClose }) {
    const repo = (status && status.repo) || "";
    const releases = (status && status.releases) || [];
    const announcements = (status && status.announcements) || [];
    const current = status && status.currentVersion;

    return (
      <div className="modal-scrim" onClick={onClose}>
        <div className="modal-card" onClick={(e) => e.stopPropagation()}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "16px 20px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <h5 style={{ margin: 0, fontSize: 16 }}>
              <i className="bi bi-clock-history" style={{ marginRight: 8 }}></i>Changelog
            </h5>
            <button className="drawer-close" onClick={onClose} aria-label="Schließen">
              <i className="bi bi-x-lg"></i>
            </button>
          </div>

          <div style={{ padding: "16px 20px" }}>
            <div className="k" style={{ marginBottom: 10 }}>Releases</div>
            {releases.length === 0 && (
              <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 16 }}>
                Keine Releases gefunden.
              </div>
            )}
            {releases.map((r) => {
              const isCurrent = current && r.version === current;
              return (
                <div
                  key={r.tag || r.version}
                  style={{
                    padding: "12px 0",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 14 }}>{r.name || r.tag}</strong>
                    <span className="tk-id" style={{ fontSize: 11 }}>{r.tag || ("v" + r.version)}</span>
                    {isCurrent && (
                      <span className="tk-status-pill done" style={{ fontSize: 10, padding: "2px 7px" }}>
                        <span className="dot"></span>installiert
                      </span>
                    )}
                    {r.publishedAt && (
                      <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{formatDate(r.publishedAt)}</span>
                    )}
                  </div>
                  {r.body && (
                    <div
                      style={{
                        whiteSpace: "pre-wrap",
                        fontSize: 12.5,
                        color: "var(--ink-2)",
                        marginTop: 8,
                        lineHeight: 1.5,
                      }}
                    >
                      {r.body}
                    </div>
                  )}
                  {r.url && (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ fontSize: 12, display: "inline-block", marginTop: 6 }}
                    >
                      Release auf GitHub ansehen
                    </a>
                  )}
                </div>
              );
            })}

            {announcements.length > 0 && (
              <div style={{ marginTop: 18 }}>
                <div className="k" style={{ marginBottom: 10 }}>Manuelle Ankündigungen</div>
                {announcements.map((a) => (
                  <div key={a.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 13.5 }}>{a.title}</strong>
                      {a.version && <span className="tk-id" style={{ fontSize: 11 }}>v{a.version}</span>}
                    </div>
                    {a.body && (
                      <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5, color: "var(--ink-2)", marginTop: 6 }}>
                        {a.body}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {repo && (
            <div
              style={{
                display: "flex",
                gap: 16,
                flexWrap: "wrap",
                padding: "14px 20px",
                borderTop: "1px solid var(--border)",
              }}
            >
              <a
                href={"https://github.com/" + repo + "/blob/master/CHANGELOG.md"}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12.5 }}
              >
                Kompletten Changelog auf GitHub ansehen
              </a>
              <a
                href={"https://github.com/" + repo + "/releases"}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12.5 }}
              >
                Alle Releases
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Ein einzelner Toast (auto-hide nach 10s).
  function Toast({ icon, title, text, onClose }) {
    React.useEffect(function () {
      const t = setTimeout(onClose, 10000);
      return function () {
        clearTimeout(t);
      };
    }, []);
    return (
      <div className="toast-x">
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <i className={"bi " + icon} style={{ color: "var(--brand)", fontSize: 16, marginTop: 1 }}></i>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{title}</div>
            {text && <div style={{ color: "var(--muted)", fontSize: 12 }}>{text}</div>}
          </div>
          <button className="close-x" onClick={onClose} aria-label="Schließen">
            <i className="bi bi-x"></i>
          </button>
        </div>
      </div>
    );
  }

  function VersionNotices() {
    useVersionRerender();
    const [modalOpen, setModalOpen] = React.useState(false);
    // Hilfs-State, um nach dem Schließen eines Toasts neu zu rendern.
    const setTick = React.useState(0)[1];
    const rerender = function () {
      setTick(function (t) {
        return t + 1;
      });
    };

    const status = window.KNOWFLOW_VERSION;
    const ls = window.KNOWFLOW_VERSION_LS;
    if (!status) return null;

    const announcements = status.announcements || [];

    // ----- Banner (oben) ----------------------------------------------------
    const banners = [];

    // 1) Update verfügbar (major/minor) und nicht weggeklickt.
    const showUpdateBanner =
      status.updateAvailable &&
      (status.updateLevel === "major" || status.updateLevel === "minor") &&
      !ls.isDismissed(status.latestVersion);

    if (showUpdateBanner) {
      banners.push(
        <div className="update-banner" key="update">
          <i className="bi bi-arrow-up-circle" style={{ fontSize: 18, color: "var(--brand)" }}></i>
          <div style={{ flex: 1 }}>
            Version {status.latestVersion} verfügbar — installiert ist {status.currentVersion}.
          </div>
          <button className="btn-primary-x" onClick={() => setModalOpen(true)}>
            <i className="bi bi-clock-history"></i>Changelog
          </button>
          {status.latestRelease && status.latestRelease.url && (
            <a
              className="btn-ghost"
              href={status.latestRelease.url}
              target="_blank"
              rel="noreferrer"
            >
              <i className="bi bi-box-arrow-up-right"></i>Zum Release
            </a>
          )}
          <button
            className="close-x"
            onClick={() => {
              ls.dismiss(status.latestVersion);
              rerender();
            }}
            aria-label="Schließen"
          >
            <i className="bi bi-x"></i>
          </button>
        </div>,
      );
    }

    // 2) Neueste nicht weggeklickte Ankündigung mit Level 'release'.
    const releaseAnnounce = announcements.find(
      (a) => a.level === "release" && !ls.isAnnounceDismissed(a.id),
    );
    if (releaseAnnounce) {
      banners.push(
        <div className="update-banner" key={"announce-" + releaseAnnounce.id}>
          <i className="bi bi-megaphone" style={{ fontSize: 18, color: "var(--brand)" }}></i>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>
              {releaseAnnounce.title}
              {releaseAnnounce.version ? " (v" + releaseAnnounce.version + ")" : ""}
            </div>
            {releaseAnnounce.body && (
              <div style={{ color: "var(--ink-2)", marginTop: 2 }}>{releaseAnnounce.body}</div>
            )}
          </div>
          <button
            className="close-x"
            onClick={() => {
              ls.dismissAnnounce(releaseAnnounce.id);
              rerender();
            }}
            aria-label="Schließen"
          >
            <i className="bi bi-x"></i>
          </button>
        </div>,
      );
    }

    // 3) API-Token-Ablauf-Erinnerungen (nicht wegklickbar, solange aktuell).
    (status.tokenReminders || []).forEach((r) => {
      const datum = formatDate(r.expiresAt);
      const text = r.expired
        ? r.label + " ist abgelaufen (seit " + datum + "). Bitte ein neues Token erstellen."
        : r.label + " läuft " +
          (r.daysLeft === 0 ? "heute" : "in " + r.daysLeft + (r.daysLeft === 1 ? " Tag" : " Tagen")) +
          " ab (am " + datum + "). Bitte erneuern oder Laufzeit verlängern.";
      banners.push(
        <div
          className="update-banner"
          key={"token-" + r.key}
          style={{ background: "var(--err-tint)", borderColor: "rgba(239,68,68,.35)" }}
        >
          <i className="bi bi-key" style={{ fontSize: 18, color: "var(--err-ink)" }}></i>
          <div style={{ flex: 1 }}>{text}</div>
        </div>,
      );
    });

    // ----- Toasts (unten rechts) --------------------------------------------
    const toasts = [];

    // a) Patch-Update.
    if (status.updateAvailable && status.updateLevel === "patch" && !ls.isToastSeen(status.latestVersion)) {
      const v = status.latestVersion;
      toasts.push(
        <Toast
          key={"patch-" + v}
          icon="bi-arrow-up-circle"
          title={"Update " + v + " verfügbar"}
          text={"Installiert ist " + status.currentVersion + "."}
          onClose={() => {
            ls.markToastSeen(v);
            rerender();
          }}
        />,
      );
    }

    // b) Ankündigungen mit Level 'patch'.
    announcements
      .filter((a) => a.level === "patch" && !ls.isToastSeen(a.id))
      .forEach((a) => {
        toasts.push(
          <Toast
            key={"announce-toast-" + a.id}
            icon="bi-megaphone"
            title={a.title}
            text={a.body || (a.version ? "Version " + a.version : "")}
            onClose={() => {
              ls.markToastSeen(a.id);
              rerender();
            }}
          />,
        );
      });

    // c) Ephemere Push-Toasts.
    (window.KNOWFLOW_VERSION_TOASTS || []).forEach((p) => {
      const text = (p.messages || []).slice(0, 3).join(" · ");
      toasts.push(
        <Toast
          key={"push-" + p.id}
          icon="bi-git"
          title={p.title || "Neue Änderungen"}
          text={text}
          onClose={() => {
            window.KNOWFLOW_VERSION_TOASTS = (window.KNOWFLOW_VERSION_TOASTS || []).filter(
              (x) => x.id !== p.id,
            );
            rerender();
          }}
        />,
      );
    });

    return (
      <>
        {banners}
        {toasts.length > 0 && <div className="toast-stack">{toasts}</div>}
        {modalOpen && <ChangelogModal status={status} onClose={() => setModalOpen(false)} />}
      </>
    );
  }

  window.VersionNotices = VersionNotices;
})();
