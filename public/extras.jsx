// ============================================================
// Wissensbasis
// ============================================================
function Knowledge() {
  window.useLiveData();
  const docs = window.KNOWFLOW_DATA.KNOWLEDGE_DOCS || [];
  const [sel, setSel] = React.useState(null);

  React.useEffect(() => {
    if (!sel && docs.length > 0) setSel(docs[0].id);
  }, [docs.length, sel]);

  const active = docs.find(d => d.id === sel) || docs[0];
  const totalBytes = docs.reduce((s, d) => s + (d.kbSize || 0) * 1024, 0);
  const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);
  const avgKb = docs.length > 0 ? Math.round(docs.reduce((s, d) => s + (d.kbSize || 0), 0) / docs.length) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Wissensbasis</h1>
          <p className="page-sub">{docs.length} aktive Markdown-Dokumente · synchronisiert mit OpenWebUI</p>
        </div>
        <div style={{display:"flex", gap:8}}>
          <button className="btn-ghost" onClick={() => window.KNOWFLOW_FULL_RELOAD && window.KNOWFLOW_FULL_RELOAD()}>
            <i className="bi bi-arrow-repeat"></i>Resync
          </button>
        </div>
      </div>

      <div className="stat-grid" style={{gridTemplateColumns:"repeat(4, 1fr)"}}>
        <div className="stat-tile"><div className="lbl"><i className="bi bi-file-earmark-text"></i>Dokumente</div><div className="num">{docs.length}</div><div className="delta">aktuell synchronisiert</div></div>
        <div className="stat-tile"><div className="lbl"><i className="bi bi-hdd"></i>Gesamtgröße</div><div className="num">{totalMb} MB</div><div className="delta">Ø {avgKb} KB / Doc</div></div>
        <div className="stat-tile"><div className="lbl"><i className="bi bi-stack"></i>Quelle</div><div className="num">Jira</div><div className="delta">über Webhook</div></div>
        <div className="stat-tile"><div className="lbl"><i className="bi bi-clock-history"></i>Letzter Sync</div><div className="num">live</div><div className="delta pos">Socket.IO</div></div>
      </div>

      {docs.length === 0 ? (
        <div className="empty">
          <i className="bi bi-journal-text"></i>
          <div>Noch keine Dokumente in der Wissensbasis. Sobald ein Ticket auf Done wechselt, erscheint hier das generierte Markdown.</div>
        </div>
      ) : (
        <div style={{display:"grid", gridTemplateColumns:"360px 1fr", gap:16}}>
          {/* Doc list */}
          <div className="card-x">
            <div className="card-head">
              <h6>Dokumente</h6>
              <span style={{fontSize:12,color:"var(--muted)"}}>{docs.length}</span>
            </div>
            <div style={{padding:"6px 0", maxHeight:560, overflowY:"auto"}}>
              {docs.map(d => (
                <div
                  key={d.id}
                  onClick={() => setSel(d.id)}
                  style={{
                    padding:"10px 16px",
                    borderLeft: sel === d.id ? "3px solid var(--brand)" : "3px solid transparent",
                    background: sel === d.id ? "var(--brand-tint)" : "transparent",
                    cursor:"pointer"
                  }}
                >
                  <div style={{display:"flex", alignItems:"center", gap:6, marginBottom:3}}>
                    <span className="tk-id" style={{fontSize:10.5, padding:"1px 6px"}}>{d.id}</span>
                    {d.status === "rework" && <span className="tk-status-pill rework" style={{fontSize:10, padding:"2px 7px"}}><span className="dot"></span>Update</span>}
                  </div>
                  <div style={{fontSize:13, fontWeight:500, color:"var(--ink)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{d.title}</div>
                  <div style={{fontSize:11, color:"var(--muted)", marginTop:2}}>{d.kbSize} KB · {d.updated}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Doc preview */}
          <div className="card-x">
            <div className="card-head">
              <h6>{active && (active.id + " · " + active.title)}</h6>
            </div>
            <div className="card-body-x">
              <div className="kv-grid" style={{marginBottom:18}}>
                <div><div className="k">OpenWebUI UUID</div><div className="v mono" style={{fontSize:11}}>{active && active.uuid}</div></div>
                <div><div className="k">Größe</div><div className="v">{active && active.kbSize} KB</div></div>
                <div><div className="k">Priorität</div><div className="v">{active && active.priority}</div></div>
                <div><div className="k">Aktualisiert</div><div className="v">{active && active.updated}</div></div>
              </div>
              <div className="md-preview" style={{maxHeight:380}}>{active && active.markdown}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================
// Logs (live tail backed by window.KNOWFLOW_LOG_BUFFER)
// ============================================================
function Logs() {
  window.useLiveData();
  const [level, setLevel] = React.useState("all");
  const [src, setSrc] = React.useState("all");
  const [paused, setPaused] = React.useState(false);
  const buffer = window.KNOWFLOW_LOG_BUFFER || [];

  const filtered = buffer.filter(l =>
    (level === "all" || l.lvl === level) &&
    (src === "all" || l.src === src)
  );

  const lvlColor = { INFO:"#60a5fa", WARN:"#fbbf24", ERROR:"#f87171", DEBUG:"#94a3b8" };

  const sources = ["all", ...Array.from(new Set(buffer.map(b => b.src))).sort()];

  const onClear = () => {
    window.KNOWFLOW_LOG_BUFFER.length = 0;
    window.dispatchEvent(new CustomEvent("knowflow:data-changed"));
  };

  const onExport = () => {
    const text = buffer.slice().reverse().map(l => `${l.t} ${l.lvl} [${l.src}] ${l.msg}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "knowflow.log";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Logs</h1>
          <p className="page-sub">Live-Stream · {filtered.length} Einträge im Puffer</p>
        </div>
        <div style={{display:"flex", gap:8}}>
          <button className="btn-ghost" onClick={() => setPaused(!paused)}>
            <i className={"bi " + (paused ? "bi-play-fill" : "bi-pause-fill")}></i>
            {paused ? "Fortsetzen" : "Pausieren"}
          </button>
          <button className="btn-ghost" onClick={onExport}><i className="bi bi-download"></i>Export .log</button>
          <button className="btn-primary-x" onClick={onClear}><i className="bi bi-trash"></i>Leeren</button>
        </div>
      </div>

      <div className="tickets-toolbar">
        <div className="filter-chips">
          {["all","INFO","WARN","ERROR","DEBUG"].map(l => (
            <button key={l} className={"chip " + (level === l ? "active" : "")} onClick={() => setLevel(l)}>
              {l !== "all" && <span className="dot" style={{background: lvlColor[l]}}></span>}
              {l === "all" ? "Alle Level" : l}
            </button>
          ))}
        </div>
        <div className="filter-chips" style={{marginLeft:"auto"}}>
          {sources.map(s => (
            <button key={s} className={"chip " + (src === s ? "active" : "")} onClick={() => setSrc(s)}>
              {s === "all" ? "Alle Quellen" : s}
            </button>
          ))}
        </div>
      </div>

      <div className="card-x" style={{overflow:"hidden"}}>
        <div className="card-head" style={{background:"#0f1729", borderColor:"#1e293b"}}>
          <h6 style={{color:"#cbd5e1"}}>
            <span style={{display:"inline-block", width:8, height:8, borderRadius:"50%", background: paused ? "#94a3b8" : "#10b981", marginRight:8, boxShadow: paused ? "none" : "0 0 0 3px rgba(16,185,129,.2)"}}></span>
            {paused ? "Pausiert" : "Live"} · stdout
          </h6>
          <span className="mono" style={{fontSize:11,color:"#64748b"}}>Socket.IO + lokaler Puffer</span>
        </div>
        <div style={{background:"#0f1729", padding:"14px 20px", maxHeight:520, overflowY:"auto", fontFamily:"'JetBrains Mono', monospace", fontSize:12, lineHeight:1.65, color:"#cbd5e1"}}>
          {filtered.length === 0 ? (
            <div style={{color:"#64748b"}}>Noch keine Log-Zeilen. Warten auf den ersten Workflow-Lauf.</div>
          ) : filtered.map((l, i) => (
            <div key={i} style={{display:"grid", gridTemplateColumns:"96px 60px 90px 1fr", gap:14, padding:"2px 0"}}>
              <span style={{color:"#64748b"}}>{l.t}</span>
              <span style={{color: lvlColor[l.lvl] || "#cbd5e1", fontWeight:600}}>{l.lvl}</span>
              <span style={{color:"#a5b4fc"}}>[{l.src}]</span>
              <span>{l.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ============================================================
// Aktivität
// ============================================================
function Activity() {
  window.useLiveData();
  const events = window.KNOWFLOW_DATA.ACTIVITY_RAW || [];
  const [kind, setKind] = React.useState("all");

  const filtered = events.filter(e => kind === "all" || e.kind === kind);

  const counts = {
    total: events.length,
    err: events.filter(e => e.kind === "err").length,
    rework: events.filter(e => e.kind === "rework").length,
    ok: events.filter(e => e.kind === "ok").length,
  };

  const stats = [
    { lbl: "Events gesamt", num: counts.total, icon: "bi-activity" },
    { lbl: "Erfolgreich", num: counts.ok, icon: "bi-check-circle" },
    { lbl: "Fehler", num: counts.err, icon: "bi-x-circle", deltaClass: counts.err > 0 ? "neg" : "" },
    { lbl: "Überarbeitungen", num: counts.rework, icon: "bi-arrow-counterclockwise" },
  ];

  const iconForKind = (k) => {
    if (k === "ok") return "bi-check-lg";
    if (k === "err") return "bi-x-octagon";
    if (k === "warn") return "bi-exclamation-triangle";
    if (k === "rework") return "bi-arrow-counterclockwise";
    return "bi-info-circle";
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Aktivität</h1>
          <p className="page-sub">Event-Stream aller Pipeline-Schritte · Live</p>
        </div>
        <div style={{display:"flex", gap:8}}>
          <button className="btn-ghost" onClick={() => window.KNOWFLOW_FULL_RELOAD && window.KNOWFLOW_FULL_RELOAD()}>
            <i className="bi bi-arrow-clockwise"></i>Aktualisieren
          </button>
        </div>
      </div>

      <div className="stat-grid">
        {stats.map((s, i) => (
          <div key={i} className="stat-tile">
            <div className="lbl"><i className={"bi " + s.icon}></i>{s.lbl}</div>
            <div className="num">{s.num}</div>
            <div className={"delta " + (s.deltaClass || "")}>Letzte 50 Events</div>
          </div>
        ))}
      </div>

      <div className="tickets-toolbar">
        <div className="filter-chips">
          {[
            { id: "all",    label: "Alle" },
            { id: "ok",     label: "Erfolgreich", dot: "var(--ok)" },
            { id: "info",   label: "Info",        dot: "var(--brand)" },
            { id: "warn",   label: "Warnungen",   dot: "var(--warn)" },
            { id: "err",    label: "Fehler",      dot: "var(--err)" },
            { id: "rework", label: "Überarbeitung", dot: "var(--rework)" },
          ].map(c => (
            <button key={c.id} className={"chip " + (kind === c.id ? "active" : "")} onClick={() => setKind(c.id)}>
              {c.dot && <span className="dot" style={{background:c.dot}}></span>}
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card-x">
        <div className="card-head">
          <h6>
            <span style={{display:"inline-block", width:8, height:8, borderRadius:"50%", background:"#10b981", marginRight:8, boxShadow:"0 0 0 3px rgba(16,185,129,.2)"}}></span>
            Event-Timeline · {filtered.length} Einträge
          </h6>
        </div>
        <div style={{padding:"4px 0"}}>
          {filtered.length === 0 ? (
            <div className="empty" style={{padding:"24px 0"}}>
              <i className="bi bi-hourglass"></i>
              <div>Noch keine Events.</div>
            </div>
          ) : filtered.map((e, i) => (
            <div key={e.id || i} style={{
              display:"grid",
              gridTemplateColumns:"72px 36px 1fr auto",
              gap:14,
              padding:"14px 20px",
              borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "0",
              alignItems:"center"
            }}>
              <div className="mono" style={{fontSize:11.5, color:"var(--muted-2)"}}>{e.age}</div>
              <div className={"act-icon " + e.kind} style={{width:32, height:32, fontSize:14}}>
                <i className={"bi " + iconForKind(e.kind)}></i>
              </div>
              <div style={{minWidth:0}}>
                <div style={{display:"flex", alignItems:"center", gap:8, marginBottom:3}}>
                  <span style={{fontSize:13.5, fontWeight:500, color:"var(--ink)"}}>{e.title}</span>
                  {e.jiraId && <span className="tk-id" style={{fontSize:10.5, padding:"1px 6px"}}>{e.jiraId}</span>}
                </div>
                <div style={{fontSize:12, color:"var(--muted)"}}>{e.detail || ""}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:11, color:"var(--muted-2)", marginBottom:2}}>Quelle</div>
                <div style={{fontSize:12, color:"var(--ink-2)", fontWeight:500}}>{e.source}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ============================================================
// Debug (nur sichtbar wenn der Server mit UI_DEBUG=true läuft)
// ============================================================
function Debug() {
  window.useLiveData();
  const [speed, setSpeed] = React.useState("normal");
  const [failAtStep, setFailAtStep] = React.useState(null);
  const [jiraId, setJiraId] = React.useState("");
  const [errorMessage, setErrorMessage] = React.useState("");
  const [lastAction, setLastAction] = React.useState(null);

  const overrides = (window.KNOWFLOW_DEBUG_STATE && window.KNOWFLOW_DEBUG_STATE.healthOverrides) || {};

  const flash = (msg) => {
    setLastAction(msg);
    window.setTimeout(() => setLastAction(null), 4000);
  };

  const runSimulation = (opts) => {
    const payload = Object.assign({ speed, failAtStep, jiraId: jiraId.trim() || undefined, errorMessage: errorMessage.trim() || undefined }, opts || {});
    if (window.KNOWFLOW_DEBUG_SIMULATE) window.KNOWFLOW_DEBUG_SIMULATE(payload);
    flash("Simulation gestartet – wechsle zu Tickets/Startseite, um den Ablauf live zu sehen.");
  };

  const goTo = (tab) => { if (window.KNOWFLOW_NAV) window.KNOWFLOW_NAV(tab); };

  const setHealth = (service, status) => {
    if (window.KNOWFLOW_DEBUG_HEALTH) window.KNOWFLOW_DEBUG_HEALTH(service, status);
    flash(status ? `${service}: Status auf „${status}" gesetzt.` : `${service}: Override entfernt.`);
    window.setTimeout(() => window.dispatchEvent(new CustomEvent("knowflow:data-changed")), 200);
  };

  const resetHealth = () => {
    if (window.KNOWFLOW_DEBUG_RESET) window.KNOWFLOW_DEBUG_RESET();
    flash("Alle Service-Overrides zurückgesetzt.");
    window.setTimeout(() => window.dispatchEvent(new CustomEvent("knowflow:data-changed")), 200);
  };

  const speeds = [
    { id: "fast", label: "Schnell", sub: "~0,25 s / Schritt" },
    { id: "normal", label: "Normal", sub: "~1,3 s / Schritt" },
    { id: "slow", label: "Langsam", sub: "~3,5 s / Schritt" },
  ];

  const failOptions = [
    { id: null, label: "Kein Abbruch", icon: "bi-check-circle" },
    { id: 0, label: "Abbruch in Schritt 1 (Jira-Load)", icon: "bi-x-circle" },
    { id: 1, label: "Abbruch in Schritt 2 (Markdown)", icon: "bi-x-circle" },
    { id: 2, label: "Abbruch in Schritt 3 (OpenWebUI)", icon: "bi-x-circle" },
  ];

  const scenarios = [
    { label: "Erfolgreicher Durchlauf", icon: "bi-play-circle", opts: { speed: "normal", failAtStep: null } },
    { label: "Langsamer Durchlauf", icon: "bi-hourglass-split", opts: { speed: "slow", failAtStep: null } },
    { label: "Abbruch: Jira nicht erreichbar", icon: "bi-plug", opts: { speed: "normal", failAtStep: 0 } },
    { label: "Abbruch: OpenWebUI down", icon: "bi-cloud-slash", opts: { speed: "slow", failAtStep: 2 } },
  ];

  const services = [
    { id: "jira", label: "Jira API" },
    { id: "openwebui", label: "OpenWebUI" },
    { id: "knowflow", label: "KnowFlow Service" },
  ];

  const statusBtns = [
    { id: "up", label: "Up", color: "var(--ok)" },
    { id: "warn", label: "Warn", color: "var(--warn)" },
    { id: "down", label: "Down", color: "var(--err)" },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Debug &amp; Demo</h1>
          <p className="page-sub">Pipeline-Abläufe und Service-Ausfälle für Präsentationen künstlich auslösen</p>
        </div>
        <div style={{display:"flex", gap:8}}>
          <button className="btn-ghost" onClick={() => goTo("tickets")}><i className="bi bi-ticket-perforated"></i>Zu Tickets</button>
          <button className="btn-ghost" onClick={() => goTo("home")}><i className="bi bi-house-door"></i>Zur Startseite</button>
        </div>
      </div>

      <div style={{
        background:"rgba(251,191,36,.1)",
        border:"1px solid rgba(251,191,36,.4)",
        borderRadius:10,
        padding:"12px 16px",
        marginBottom:18,
        display:"flex",
        alignItems:"center",
        gap:10,
        fontSize:13,
        color:"#92400e"
      }}>
        <i className="bi bi-exclamation-triangle-fill" style={{fontSize:16, color:"#d97706"}}></i>
        <div>
          <b>UI-Debug-Modus aktiv.</b> Alle Aktionen hier sind reine Simulationen und greifen
          auf keine echten Jira- oder OpenWebUI-APIs zu. Dieser Tab erscheint nur, wenn der Server
          mit <code style={{fontFamily:"'JetBrains Mono',monospace"}}>UI_DEBUG=true</code> läuft.
        </div>
      </div>

      {lastAction && (
        <div style={{
          background:"var(--brand-tint)",
          border:"1px solid #c7d2fe",
          borderRadius:8,
          padding:"10px 14px",
          marginBottom:16,
          fontSize:13,
          color:"#3730a3",
          display:"flex",
          alignItems:"center",
          gap:8
        }}>
          <i className="bi bi-info-circle"></i>{lastAction}
        </div>
      )}

      {/* Schnellszenarien */}
      <div className="card-x" style={{marginBottom:16}}>
        <div className="card-head"><h6>Schnellszenarien</h6><span style={{fontSize:12,color:"var(--muted)"}}>1 Klick</span></div>
        <div className="card-body-x">
          <div style={{display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:10}}>
            {scenarios.map((s, i) => (
              <button key={i} className="btn-ghost" style={{justifyContent:"flex-start", padding:"12px 14px"}} onClick={() => runSimulation(s.opts)}>
                <i className={"bi " + s.icon} style={{fontSize:16}}></i>
                <span style={{fontWeight:600}}>{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Manueller Ticket-Transfer */}
      <div className="card-x" style={{marginBottom:16}}>
        <div className="card-head"><h6>Ticket-Transfer simulieren</h6></div>
        <div className="card-body-x">
          <div style={{marginBottom:16}}>
            <div className="k" style={{marginBottom:8}}>Tempo</div>
            <div className="filter-chips">
              {speeds.map(s => (
                <button key={s.id} className={"chip " + (speed === s.id ? "active" : "")} onClick={() => setSpeed(s.id)}>
                  {s.label}<span className="count">{s.sub}</span>
                </button>
              ))}
            </div>
          </div>

          <div style={{marginBottom:16}}>
            <div className="k" style={{marginBottom:8}}>Fehler-Injektion</div>
            <div style={{display:"flex", flexDirection:"column", gap:6}}>
              {failOptions.map(f => (
                <button
                  key={String(f.id)}
                  className={"chip " + (failAtStep === f.id ? "active" : "")}
                  style={{justifyContent:"flex-start"}}
                  onClick={() => setFailAtStep(f.id)}
                >
                  <span className="dot" style={{background: f.id === null ? "var(--ok)" : "var(--err)"}}></span>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16}}>
            <div>
              <div className="k" style={{marginBottom:6}}>Ticket-ID (optional)</div>
              <input
                className="dbg-input"
                type="text"
                placeholder="z. B. KNOW-9001 – leer = DEMO-Key"
                value={jiraId}
                onChange={e => setJiraId(e.target.value)}
                style={{width:"100%", padding:"9px 12px", border:"1px solid var(--border)", borderRadius:8, fontSize:13}}
              />
            </div>
            <div>
              <div className="k" style={{marginBottom:6}}>Fehlertext (optional)</div>
              <input
                className="dbg-input"
                type="text"
                placeholder="leer = realistischer Standardfehler"
                value={errorMessage}
                onChange={e => setErrorMessage(e.target.value)}
                disabled={failAtStep === null}
                style={{width:"100%", padding:"9px 12px", border:"1px solid var(--border)", borderRadius:8, fontSize:13, opacity: failAtStep === null ? .5 : 1}}
              />
            </div>
          </div>

          <button className="btn-primary-x" onClick={() => runSimulation()}>
            <i className="bi bi-lightning-charge-fill"></i>Simulation starten
          </button>
        </div>
      </div>

      {/* Service-Verfügbarkeit */}
      <div className="card-x">
        <div className="card-head">
          <h6>Service-Verfügbarkeit simulieren</h6>
          <button className="btn-ghost" onClick={resetHealth} style={{padding:"5px 10px"}}>
            <i className="bi bi-arrow-counterclockwise"></i>Zurücksetzen
          </button>
        </div>
        <div className="card-body-x">
          <p style={{fontSize:12.5, color:"var(--muted)", marginTop:0, marginBottom:14}}>
            Erzwingt den Status auf der Startseite (Systemstatus-Kacheln). Damit lässt sich zeigen,
            wie das Dashboard reagiert, wenn ein Dienst „nicht erreichbar" ist.
          </p>
          <div style={{display:"flex", flexDirection:"column", gap:10}}>
            {services.map(svc => {
              const current = overrides[svc.id] || null;
              return (
                <div key={svc.id} style={{display:"flex", alignItems:"center", gap:12, padding:"10px 12px", border:"1px solid var(--border)", borderRadius:8}}>
                  <div style={{flex:1, fontWeight:600, fontSize:13.5}}>{svc.label}</div>
                  {current && (
                    <span style={{fontSize:11, color:"var(--muted)"}}>
                      erzwungen: <b style={{color:"var(--ink-2)"}}>{current}</b>
                    </span>
                  )}
                  <div style={{display:"flex", gap:6}}>
                    {statusBtns.map(b => (
                      <button
                        key={b.id}
                        onClick={() => setHealth(svc.id, b.id)}
                        style={{
                          padding:"5px 12px",
                          borderRadius:7,
                          fontSize:12,
                          fontWeight:600,
                          cursor:"pointer",
                          border: "1px solid " + (current === b.id ? b.color : "var(--border)"),
                          background: current === b.id ? b.color : "#fff",
                          color: current === b.id ? "#fff" : "var(--ink-2)"
                        }}
                      >{b.label}</button>
                    ))}
                    <button
                      onClick={() => setHealth(svc.id, null)}
                      title="Override entfernen"
                      style={{padding:"5px 10px", borderRadius:7, fontSize:12, cursor:"pointer", border:"1px solid var(--border)", background:"#fff", color:"var(--muted)"}}
                    ><i className="bi bi-x-lg"></i></button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

window.Knowledge = Knowledge;
window.Logs = Logs;
window.Activity = Activity;
window.Debug = Debug;
