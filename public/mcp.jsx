// ============================================================
// MCP-Verbindungen
// ============================================================
function mcpHumanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function McpCard({ conn }) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const copy = () => {
    try {
      navigator.clipboard.writeText(conn.endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (_err) {
      // Clipboard not available: ignore silently.
    }
  };

  return (
    <div className="card-x" style={{ marginBottom: 14, border: conn.isAll ? "1px solid var(--brand)" : undefined }}>
      <div className="card-head">
        <h6 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <i className="bi bi-diagram-3"></i>
          {conn.title}
          {conn.isAll && <span className="tk-status-pill" style={{ background: "var(--brand)", color: "#fff", fontSize: 10, padding: "2px 8px" }}>Gesamtes Wissen</span>}
        </h6>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>{conn.docCount} Wissenseinträge</span>
      </div>
      <div className="card-body-x">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span className="mono" style={{
            flex: 1,
            fontSize: 12,
            padding: "8px 10px",
            background: "var(--brand-tint)",
            borderRadius: 8,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }}>{conn.endpoint}</span>
          <button className="btn-ghost" style={{ padding: "7px 11px" }} onClick={copy}>
            <i className={"bi " + (copied ? "bi-check-lg" : "bi-clipboard")}></i>{copied ? "Kopiert!" : "Kopieren"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 18, fontSize: 12.5, color: "var(--muted)", marginBottom: 8 }}>
          <span><i className="bi bi-file-earmark-text" style={{ marginRight: 5 }}></i>{conn.docCount} Wissenseinträge</span>
          <span><i className="bi bi-hdd" style={{ marginRight: 5 }}></i>{mcpHumanBytes(conn.totalBytes)}</span>
        </div>

        <button className="btn-ghost" style={{ padding: "5px 10px" }} onClick={() => setOpen((o) => !o)}>
          <i className={"bi " + (open ? "bi-chevron-up" : "bi-chevron-down")}></i>Erweitert
        </button>
        {open && (
          <div style={{ marginTop: 10, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
            {conn.description || <span style={{ color: "var(--muted)" }}>Keine Beschreibung hinterlegt.</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function Mcp() {
  window.useLiveData();
  const [connections, setConnections] = React.useState([]);
  const [error, setError] = React.useState(null);

  const load = React.useCallback(() => {
    fetch("/api/mcp/connections")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
      .then((d) => { setConnections(d.connections || []); setError(null); })
      .catch((e) => setError(e.message));
  }, []);

  React.useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">MCP-Verbindungen</h1>
          <p className="page-sub">{connections.length} Verbindungen · stellen Wissen über das Model Context Protocol bereit</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-ghost" onClick={load}><i className="bi bi-arrow-clockwise"></i>Aktualisieren</button>
        </div>
      </div>

      {error && (
        <div style={{ background: "var(--err-tint)", border: "1px solid rgba(239,68,68,.35)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "var(--err-ink)" }}>
          Verbindungen konnten nicht geladen werden: {error}
        </div>
      )}

      {connections.length === 0 && !error ? (
        <div className="empty"><i className="bi bi-diagram-3"></i><div>Keine MCP-Verbindungen verfügbar.</div></div>
      ) : (
        connections.map((c) => <McpCard key={c.id} conn={c} />)
      )}
    </>
  );
}

window.Mcp = Mcp;
