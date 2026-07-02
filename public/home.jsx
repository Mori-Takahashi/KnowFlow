function Home() {
  const { HEALTH, ACTIVITY, STATS, THROUGHPUT, FUNNEL, LAST_UPDATE } = window.KNOWFLOW_DATA;
  window.useLiveData();

  // Sichtbares Pending-Feedback für die beiden Kopf-Aktionen.
  const [reloading, setReloading] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const doReload = async () => {
    if (!window.KNOWFLOW_FULL_RELOAD || reloading) return;
    setReloading(true);
    try { await window.KNOWFLOW_FULL_RELOAD(); } finally { setReloading(false); }
  };
  const doSync = async () => {
    if (!window.KNOWFLOW_MANUAL_SYNC || syncing) return;
    setSyncing(true);
    try { await window.KNOWFLOW_MANUAL_SYNC(); } finally { setSyncing(false); }
  };

  const ageLabel = (() => {
    if (!LAST_UPDATE) return "noch nicht aktualisiert";
    const sec = Math.max(0, Math.floor((Date.now() - LAST_UPDATE) / 1000));
    if (sec < 5) return "gerade eben";
    if (sec < 60) return "vor " + sec + " Sek.";
    return "vor " + Math.floor(sec / 60) + " Min.";
  })();

  const totalThroughput = THROUGHPUT.reduce((s, d) => s + d.ok + d.err + d.rw, 0);
  const sumFunnel = FUNNEL && FUNNEL.length > 0 ? FUNNEL[0].count : 0;
  const funnelRows = (FUNNEL && FUNNEL.length === 3 ? FUNNEL : [
    { step: 1, name: "Aus Jira laden", count: 0 },
    { step: 2, name: "Markdown speichern", count: 0 },
    { step: 3, name: "OpenWebUI Upload", count: 0 },
  ]).map((f) => ({
    ...f,
    pct: sumFunnel > 0 ? Math.round((f.count / sumFunnel) * 100) : 0,
  }));

  const stats = [
    { lbl: "Tickets verarbeitet", num: (STATS.totalProcessed || 0).toLocaleString("de-DE"),
      delta: "+" + (STATS.thisWeek || 0) + " diese Woche", deltaClass: "pos", icon: "bi-check2-circle" },
    { lbl: "Aktuell in Bearbeitung", num: STATS.inProgress || 0,
      delta: (STATS.inProgress || 0) > 0 ? "Pipeline läuft" : "keine Aktivität", icon: "bi-arrow-repeat" },
    { lbl: "Wissen in OpenWebUI", num: (STATS.knowledgeKb || 0) + " MB",
      delta: (window.KNOWFLOW_DATA.KNOWLEDGE_DOCS || []).length + " Dokumente", icon: "bi-database" },
    { lbl: "Fehler · Überarbeitung", num: (STATS.errors || 0) + " · " + (STATS.rework || 0),
      delta: (STATS.errors || 0) > 0 ? "Retry möglich" : "alles grün",
      deltaClass: (STATS.errors || 0) > 0 ? "neg" : "pos", icon: "bi-exclamation-triangle" },
  ];

  const maxBar = Math.max(1, ...THROUGHPUT.map(d => d.ok + d.err + d.rw));

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Startseite</h1>
          <p className="page-sub">Systemstatus und Pipeline-Übersicht · aktualisiert {ageLabel}</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button className="btn-ghost" onClick={doReload} disabled={reloading}>
            {reloading ? <Spinner /> : <i className="bi bi-arrow-clockwise"></i>}Aktualisieren
          </button>
          <button className="btn-primary-x" onClick={doSync} disabled={syncing}>
            {syncing ? <Spinner /> : <i className="bi bi-lightning-charge-fill"></i>}Manuell synchronisieren
          </button>
        </div>
      </div>

      {/* Health */}
      <div className="health-grid">
        {HEALTH.map(h => (
          <div key={h.name} className="health-card">
            <div className="health-top">
              <div className="health-name">
                <div className={"svc-icon " + (h.iconClass || "")}><i className={"bi " + h.icon}></i></div>
                <div>
                  <div>{h.name}</div>
                  <div style={{fontSize:11.5, color:"var(--muted-2)", fontWeight:400, marginTop:1}}>{h.version}</div>
                </div>
              </div>
              <span className={"health-status " + h.status}>
                <span className="pulse"></span>{h.statusLabel}
              </span>
            </div>
            <div className="uptime-bar">
              {(h.bars || []).map((b, i) => <div key={i} className={"seg " + (b === 'ok' ? '' : b)}></div>)}
            </div>
            <div className="health-meta">
              <div><span className="lbl">Uptime</span><span className="val">{h.uptime}</span></div>
              <div><span className="lbl">Latenz</span><span className="val">{h.latency}</span></div>
              <div style={{gridColumn:"span 2"}}><span className="lbl">Status</span><span className="val">{h.queue}</span></div>
            </div>
          </div>
        ))}
      </div>

      {/* Stat tiles */}
      <div className="stat-grid">
        {stats.map((s, i) => (
          <div key={i} className="stat-tile">
            <div className="lbl"><i className={"bi " + s.icon}></i>{s.lbl}</div>
            <div className="num">{s.num}</div>
            <div className={"delta " + (s.deltaClass || "")}>{s.delta}</div>
          </div>
        ))}
      </div>

      {/* Two-column: chart + activity */}
      <div className="two-col">
        <div className="card-x">
          <div className="card-head">
            <h6>Durchsatz · letzte 7 Tage</h6>
            <span style={{fontSize:12,color:"var(--muted)"}}>{totalThroughput} Ereignisse gesamt</span>
          </div>
          <div className="card-body-x">
            <div className="chart-wrap">
              <div className="bars">
                {THROUGHPUT.map((d, i) => {
                  const h = (v) => v === 0 ? 0 : Math.max(2, Math.round((v / maxBar) * 140));
                  return (
                    <div key={i} className="bar-col">
                      <div className="stack">
                        {d.rw > 0 && <div className="seg-rw" style={{height: h(d.rw) + 'px'}}></div>}
                        {d.err > 0 && <div className="seg-er" style={{height: h(d.err) + 'px'}}></div>}
                        {d.ok > 0 && <div className="seg-ok" style={{height: h(d.ok) + 'px'}}></div>}
                      </div>
                      <div className="day">{d.day}</div>
                    </div>
                  );
                })}
              </div>
              <div className="legend">
                <span className="ld"><span className="sw" style={{background:"var(--ok)"}}></span>Erfolgreich</span>
                <span className="ld"><span className="sw" style={{background:"var(--err)"}}></span>Fehler</span>
                <span className="ld"><span className="sw" style={{background:"var(--rework)"}}></span>Überarbeitet</span>
              </div>
            </div>
          </div>
        </div>

        <div className="card-x">
          <div className="card-head">
            <h6>Workflow-Verteilung</h6>
            <span style={{fontSize:12,color:"var(--muted)"}}>aktive Tickets</span>
          </div>
          <div className="card-body-x">
            <div className="funnel">
              {funnelRows.map(f => (
                <div key={f.step} className="funnel-row">
                  <div className="funnel-step">{f.step}</div>
                  <div className="funnel-body">
                    <div className="funnel-name"><span>{f.name}</span><span className="pct">{f.pct}%</span></div>
                    <div className="funnel-track"><div className="funnel-fill" style={{width: f.pct + "%"}}></div></div>
                  </div>
                  <div className="funnel-count">{f.count}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Activity feed */}
      <div className="card-x">
        <div className="card-head">
          <h6>Letzte Aktivität</h6>
          <span style={{fontSize:12, color:"var(--muted)"}}>Live</span>
        </div>
        <div className="card-body-x" style={{paddingTop:4, paddingBottom:4}}>
          {ACTIVITY.length === 0 ? (
            <div className="empty" style={{padding:"24px 0"}}>
              <i className="bi bi-hourglass"></i>
              <div>Noch keine Aktivität. Warten auf den ersten Jira-Webhook.</div>
            </div>
          ) : ACTIVITY.slice(0, 7).map((a, i) => (
            <div key={i} className="activity-row">
              <div className={"act-icon " + a.kind}>
                <i className={"bi " + (
                  a.kind === "ok" ? "bi-check-lg" :
                  a.kind === "err" ? "bi-x-lg" :
                  a.kind === "warn" ? "bi-exclamation" :
                  a.kind === "rework" ? "bi-arrow-repeat" :
                  "bi-info"
                )}></i>
              </div>
              <div className="act-text">
                {a.before}
                {a.id && <> <span className="tid">{a.id}</span></>}
                {a.after}
              </div>
              <div className="act-time">{a.time}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

window.Home = Home;
