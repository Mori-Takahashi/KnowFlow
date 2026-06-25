function Sidebar({ active, setActive, counts, access, onLogout }) {
  const items = [
    { id: "home", label: "Startseite", icon: "bi-house-door" },
    { id: "tickets", label: "Tickets", icon: "bi-ticket-perforated", badge: counts.tickets },
    { id: "activity", label: "Aktivität", icon: "bi-activity" },
    { id: "knowledge", label: "Wissensbasis", icon: "bi-journal-text" },
    { id: "mcp", label: "MCP", icon: "bi-diagram-3" },
    { id: "logs", label: "Logs", icon: "bi-terminal" },
  ];
  // Debug entry only appears when the server runs with UI_DEBUG=true.
  if (window.KNOWFLOW_DEBUG_ENABLED) {
    items.push({ id: "debug", label: "Debug", icon: "bi-bug" });
  }
  const settings = [
    { id: "admin", label: "Einstellungen", icon: "bi-shield-lock" },
  ];

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark">JB</div>
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
          onClick={() => setActive(it.id)}
        >
          <i className={"bi " + it.icon}></i>
          <span>{it.label}</span>
          {it.badge != null && <span className="nav-badge">{it.badge}</span>}
        </button>
      ))}

      <div className="nav-section-label">Verwaltung</div>
      {settings.map(it => (
        <button
          key={it.id}
          className={"nav-item " + (active === it.id ? "active" : "")}
          onClick={() => setActive(it.id)}
        >
          <i className={"bi " + it.icon}></i>
          <span>{it.label}</span>
        </button>
      ))}

      {window.KNOWFLOW_DEBUG_ENABLED && (
        <div style={{
          margin:"10px 12px 0",
          padding:"7px 10px",
          borderRadius:8,
          background:"rgba(251,191,36,.12)",
          border:"1px solid rgba(251,191,36,.35)",
          color:"#fbbf24",
          fontSize:11.5,
          fontWeight:600,
          display:"flex",
          alignItems:"center",
          gap:7
        }}>
          <i className="bi bi-bug-fill"></i>Debug-Modus aktiv
        </div>
      )}

      {access && access.authenticated && (
        <div style={{
          margin:"10px 12px 0",
          padding:"8px 10px",
          borderRadius:8,
          background:"rgba(148,163,184,.12)",
          border:"1px solid rgba(148,163,184,.25)",
          display:"flex",
          alignItems:"center",
          gap:8,
          fontSize:11.5
        }}>
          <i className={"bi " + (access.role === "admin" ? "bi-shield-check" : "bi-person-badge")} style={{color:"#cbd5e1"}}></i>
          <span style={{color:"#cbd5e1",fontWeight:600,flex:1}}>
            {access.role === "admin" ? "Admin" : "Benutzer"}
          </span>
          <button
            onClick={onLogout}
            title="Abmelden"
            style={{background:"transparent",border:"none",color:"#94a3b8",cursor:"pointer",padding:0,fontSize:14}}
          >
            <i className="bi bi-box-arrow-right"></i>
          </button>
        </div>
      )}

      <div className="sidebar-footer">
        <div className="foot-dot"></div>
        <div>
          <div style={{color:"#cbd5e1",fontWeight:500}}>Alle Systeme</div>
          <div style={{fontSize:11,marginTop:1}}>betriebsbereit</div>
        </div>
      </div>
    </aside>
  );
}

window.Sidebar = Sidebar;
