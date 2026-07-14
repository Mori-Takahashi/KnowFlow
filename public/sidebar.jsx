function Sidebar({ active, setActive, counts, access, quickChatEnabled, onLogout, open, onClose }) {
  const items = [
    { id: "home", label: "Startseite", icon: "bi-house-door" },
    { id: "tickets", label: "Tickets", icon: "bi-ticket-perforated", badge: counts.tickets },
    { id: "activity", label: "Aktivität", icon: "bi-activity" },
    { id: "knowledge", label: "Wissensbasis", icon: "bi-journal-text" },
    { id: "mcp", label: "MCP", icon: "bi-diagram-3" },
    { id: "logs", label: "Logs", icon: "bi-terminal" },
  ];
  // The temporary chat only appears when an admin has enabled it.
  if (quickChatEnabled) {
    items.splice(4, 0, { id: "chat", label: "Schneller Chat", icon: "bi-chat-dots", tag: "Beta" });
  }
  // Debug entry only appears when the server runs with UI_DEBUG=true.
  if (window.KNOWFLOW_DEBUG_ENABLED) {
    items.push({ id: "debug", label: "Debug", icon: "bi-bug" });
  }
  const settings = [
    { id: "admin", label: "Einstellungen", icon: "bi-shield-lock" },
  ];

  // Mobil: Escape schließt die geöffnete Off-Canvas-Sidebar.
  React.useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape" && onClose) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const navigate = (id) => {
    setActive(id);
    if (onClose) onClose();
  };

  return (
    <aside className={"sidebar" + (open ? " open" : "")}>
      <div className="brand-row">
        <div className="brand-mark"><BrandMark size={18} /></div>
        <div>
          <div className="brand-name">KnowFlow</div>
          <div className="brand-sub">Knowledge Pipeline</div>
        </div>
      </div>

      <div className="nav-section-label">Übersicht</div>
      {items.map(it => (
        <button
          key={it.id}
          className={"nav-item " + (active === it.id ? "active" : "")}
          onClick={() => navigate(it.id)}
        >
          <i className={"bi " + it.icon}></i>
          <span>{it.label}</span>
          {it.tag && <span className="nav-tag">{it.tag}</span>}
          {it.badge != null && <span className="nav-badge">{it.badge}</span>}
        </button>
      ))}

      <div className="nav-section-label">Verwaltung</div>
      {settings.map(it => (
        <button
          key={it.id}
          className={"nav-item " + (active === it.id ? "active" : "")}
          onClick={() => navigate(it.id)}
        >
          <i className={"bi " + it.icon}></i>
          <span>{it.label}</span>
        </button>
      ))}

      {window.KNOWFLOW_DEBUG_ENABLED && (
        <div className="sidebar-note">
          <i className="bi bi-bug-fill"></i>Debug-Modus aktiv
        </div>
      )}

      {access && access.authenticated && (
        <div className="sidebar-user">
          <i className={"bi " + (access.role === "admin" ? "bi-shield-check" : "bi-person-badge")}></i>
          <span className="role">
            {access.role === "admin" ? "Admin" : "Benutzer"}
          </span>
          <button onClick={onLogout} title="Abmelden" className="logout-btn">
            <i className="bi bi-box-arrow-right"></i>
          </button>
        </div>
      )}

      <div className="sidebar-footer">
        <div className="foot-dot"></div>
        <div style={{flex:1}}>
          <div className="sidebar-foot-text">Alle Systeme</div>
          <div className="sidebar-foot-sub">betriebsbereit</div>
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}

window.Sidebar = Sidebar;
