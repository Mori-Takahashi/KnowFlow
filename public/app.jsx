function Placeholder({ title, icon, msg }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">{msg}</p>
        </div>
      </div>
      <div className="empty">
        <i className={"bi " + icon}></i>
        <div>Diese Ansicht wird in einer kommenden Iteration ausgebaut.</div>
      </div>
    </>
  );
}

// Hook used by every top-level view to re-render when data.jsx broadcasts
// a 'knowflow:data-changed' event (initial fetch finishes, socket update, etc).
function useLiveData() {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const handler = () => setTick((t) => t + 1);
    window.addEventListener("knowflow:data-changed", handler);
    return () => window.removeEventListener("knowflow:data-changed", handler);
  }, []);
}
window.useLiveData = useLiveData;

// Read the optional ?ticket=KEY query parameter. When present, the app boots
// straight into the Tickets tab and the Tickets view opens the drawer for that
// ticket via window.KNOWFLOW_DEEP_LINK_TICKET.
function readDeepLinkTicket() {
  try {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("ticket");
    return id && id.trim() ? id.trim() : null;
  } catch (_err) {
    return null;
  }
}

function App() {
  useLiveData();
  const initialDeepLink = React.useMemo(() => readDeepLinkTicket(), []);
  const [active, setActive] = React.useState(initialDeepLink ? "tickets" : "home");

  // Mobile: Off-Canvas-Sidebar (Hamburger in der Topbar öffnet, Scrim/Navigation schließt).
  const [navOpen, setNavOpen] = React.useState(false);
  const closeNav = React.useCallback(() => setNavOpen(false), []);

  // Ersteinrichtung: Beim allerersten Start (noch kein Admin-Passwort) liefert
  // /api/setup/status required=true und wir zeigen den Setup-Assistenten statt
  // des Dashboards. null = noch unbekannt (kurzer Moment vor der Antwort).
  const [setupRequired, setSetupRequired] = React.useState(null);
  React.useEffect(() => {
    fetch("/api/setup/status")
      .then((r) => r.json())
      .then((d) => setSetupRequired(Boolean(d.required)))
      .catch(() => setSetupRequired(false)); // im Fehlerfall normal das Dashboard zeigen
  }, []);

  // Zugriffsstatus: ob das Dashboard gesperrt ist und welche Rolle/Rechte die
  // aktuelle Sitzung hat. Wird global gespiegelt (window.KNOWFLOW_ACCESS), damit
  // andere Views (z. B. Lebenszyklus-Buttons) die Rechte kennen. null = lädt.
  const [access, setAccess] = React.useState(null);
  const loadAccess = React.useCallback(() => {
    return fetch("/api/access")
      .then((r) => r.json())
      .then((d) => { window.KNOWFLOW_ACCESS = d; setAccess(d); return d; })
      .catch(() => {
        const fallback = { dashboardLocked: false, authenticated: false, role: null, permissions: null };
        window.KNOWFLOW_ACCESS = fallback;
        setAccess(fallback);
        return fallback;
      });
  }, []);
  React.useEffect(() => {
    window.KNOWFLOW_RELOAD_ACCESS = loadAccess;
    loadAccess();
  }, [loadAccess]);

  // Schneller Chat: whether the admin has enabled the temporary chat. Mirrored
  // on window so the view can read the allowed models without re-fetching.
  // The /api/quickchat/config probe sits behind the dashboard-lock gate, so a
  // locked dashboard returns 401 (enabled=false) until a session exists. It must
  // therefore be re-fetched after login/logout, not just once on mount —
  // otherwise the nav entry only appears after a full page reload.
  const [quickChatEnabled, setQuickChatEnabled] = React.useState(false);
  const loadQuickChatConfig = React.useCallback(() => {
    return fetch("/api/quickchat/config")
      .then((r) => r.json())
      .then((c) => { window.KNOWFLOW_QUICKCHAT = c; setQuickChatEnabled(Boolean(c.enabled)); })
      .catch(() => { window.KNOWFLOW_QUICKCHAT = { enabled: false, models: [], hasKnowledge: false }; setQuickChatEnabled(false); });
  }, []);
  React.useEffect(() => { loadQuickChatConfig(); }, [loadQuickChatConfig]);

  // Expose tab navigation so the Debug panel can jump to a live view after
  // starting a simulation.
  React.useEffect(() => {
    window.KNOWFLOW_NAV = setActive;
  }, []);

  // Publish the deep-link target so Tickets can pick it up after mount.
  React.useEffect(() => {
    if (initialDeepLink) {
      window.KNOWFLOW_DEEP_LINK_TICKET = initialDeepLink;
    }
  }, [initialDeepLink]);

  const counts = { tickets: window.KNOWFLOW_DATA.TICKETS_TOTAL || window.KNOWFLOW_DATA.TICKETS.length };

  // Gate: solange der Setup-Status unbekannt ist, eine Ladeanzeige zeigen; ist
  // die Ersteinrichtung erforderlich, den Vollbild-Assistenten statt der Shell zeigen.
  if (setupRequired === null || access === null) return <LoadingScreen />;
  if (setupRequired) {
    return <SetupWizard onComplete={() => setSetupRequired(false)} />;
  }

  // Vollständige Sperre: Ist das Dashboard gesperrt und keine Sitzung aktiv,
  // zeigt ein Vollbild-Login statt des Dashboards. Nach erfolgreicher Anmeldung
  // werden Zugriffsstatus und Daten neu geladen.
  if (access.dashboardLocked && !access.authenticated && window.LockScreen) {
    return (
      <LockScreen
        userLoginEnabled={access.userLoginEnabled}
        onSuccess={() => loadAccess().then(() => loadQuickChatConfig()).then(() => { if (window.KNOWFLOW_FULL_RELOAD) window.KNOWFLOW_FULL_RELOAD(); })}
      />
    );
  }

  // Erste Daten noch unterwegs: Ladeanzeige statt eines leeren Dashboards.
  // loadAll() setzt READY auch bei Fehlern, hängen bleiben kann das hier nicht.
  if (!window.KNOWFLOW_DATA.READY) return <LoadingScreen />;

  let view;
  if (active === "home") view = <Home />;
  else if (active === "tickets") view = <Tickets />;
  else if (active === "activity") view = <Activity />;
  else if (active === "knowledge") view = <Knowledge />;
  else if (active === "chat") view = quickChatEnabled ? <QuickChat /> : <Home />;
  else if (active === "mcp") view = <Mcp />;
  else if (active === "admin") view = <Admin />;
  else if (active === "debug") view = <Debug />;
  else view = <Logs />;

  const onLogout = () => {
    fetch("/api/admin/logout", { method: "POST", headers: { "x-csrf-token": window.getCsrfToken ? window.getCsrfToken() : "" } })
      .catch(() => {})
      .then(() => loadAccess())
      .then(() => loadQuickChatConfig())
      .then(() => { if (window.KNOWFLOW_FULL_RELOAD) window.KNOWFLOW_FULL_RELOAD(); });
  };

  return (
    <div className="shell">
      {/* Nur auf kleinen Bildschirmen sichtbar (CSS blendet sie ≤900px ein) */}
      <header className="topbar">
        <button
          className="topbar-burger"
          onClick={() => setNavOpen(true)}
          aria-label="Navigation öffnen"
          aria-expanded={navOpen}
        >
          <i className="bi bi-list"></i>
        </button>
        <div className="topbar-brand">
          <span className="brand-mark"><BrandMark size={16} /></span>
          KnowFlow
        </div>
        <ThemeToggle />
      </header>
      <div className={"sidebar-scrim" + (navOpen ? " open" : "")} onClick={closeNav}></div>
      <Sidebar active={active} setActive={setActive} counts={counts} access={access} quickChatEnabled={quickChatEnabled} onLogout={onLogout} open={navOpen} onClose={closeNav} />
      <main className="main" data-screen-label={"Tab · " + active}>
        {window.VersionNotices && <VersionNotices />}
        {/* key={active} remountet nur beim Tab-Wechsel — Live-Updates über
            Socket.IO behalten den Key und spielen die Animation nicht erneut ab. */}
        <div className="view-anim" key={active}>
          {view}
        </div>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
