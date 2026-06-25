function statusInfo(s) {
  if (s === "done")   return { cls: "done",   label: "Done",            icon: "bi-check-circle-fill" };
  if (s === "work")   return { cls: "work",   label: "In Arbeit",       icon: "bi-arrow-repeat" };
  if (s === "err")    return { cls: "err",    label: "Fehler",          icon: "bi-exclamation-triangle-fill" };
  if (s === "rework") return { cls: "rework", label: "Wird Überarbeitet", icon: "bi-arrow-counterclockwise" };
  return                       { cls: "idle",  label: "Wartet",          icon: "bi-circle" };
}

const STEP_NAMES = ["Aus Jira laden", "Markdown speichern", "OpenWebUI Upload"];

function WorkflowBar({ wf }) {
  return (
    <div className="wf-bar">
      {wf.map((st, i) => {
        const stepClass = st === "done" ? "done" : st === "work" ? "work" : st === "err" ? "err" : "idle";
        return (
          <div key={i} className={"wf-seg " + stepClass}>
            <div className="bar"></div>
            <div className="lbl">
              {st === "done" && <i className="bi bi-check2"></i>}
              {st === "work" && <i className="bi bi-three-dots"></i>}
              {st === "err"  && <i className="bi bi-x"></i>}
              {st === "idle" && <i className="bi bi-dash"></i>}
              <span>{i+1}. {STEP_NAMES[i]}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function lifecycleBadge(lifecycle) {
  if (lifecycle === "obsolete") return { label: "Veraltet", color: "var(--warn)" };
  if (lifecycle === "deleted") return { label: "Gelöscht", color: "var(--err)" };
  return null;
}

function TicketCard({ t, onOpen }) {
  const si = statusInfo(t.status);
  const extra = t.status === "rework" ? "rework" : t.status === "err" ? "err" : "";
  const lc = lifecycleBadge(t.lifecycle);
  return (
    <div className={"ticket-card " + extra} onClick={() => onOpen(t)} style={lc ? { opacity: 0.55 } : undefined}>
      <div className="tk-head">
        <div className="tk-id-row">
          <span className="tk-id">{t.id}</span>
          {lc && <span className="tk-status-pill" style={{ background: lc.color, color: "#fff" }}><span className="dot" style={{ background: "#fff" }}></span>{lc.label}</span>}
          <span className="tk-meta-tag"><i className="bi bi-person"></i>{t.assignee}</span>
          <span className="tk-meta-tag"><i className="bi bi-flag"></i>{t.priority}</span>
        </div>
        <h3 className="tk-title">{t.title}</h3>
        <div className="tk-sub">
          <span>Jira-Status: <b style={{color:"var(--ink-2)"}}>{t.jiraStatus}</b></span>
          <span className="sep">·</span>
          <span>aktualisiert {t.updated}</span>
          {t.kbSize > 0 && <>
            <span className="sep">·</span>
            <span><i className="bi bi-file-earmark-text" style={{marginRight:4}}></i>{t.kbSize} KB Markdown</span>
          </>}
        </div>
      </div>
      <WorkflowBar wf={t.wf} />
      <span className={"tk-status-pill " + si.cls}>
        <i className={"bi " + si.icon}></i>
        {si.label}
      </span>
    </div>
  );
}

function humanizeFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function Drawer({ ticket, onClose, onRetry }) {
  const [detail, setDetail] = React.useState(null);
  const [lcMsg, setLcMsg] = React.useState(null);

  const reload = React.useCallback((id) => {
    if (!id) return;
    fetch("/api/tickets/" + encodeURIComponent(id))
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setDetail(d); })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    if (!ticket) { setDetail(null); setLcMsg(null); return; }
    let cancelled = false;
    fetch("/api/tickets/" + encodeURIComponent(ticket.id))
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ticket && ticket.id]);

  const lifecycleAction = async (id, action, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setLcMsg(null);
    try {
      const resp = await fetch("/api/admin/tickets/" + encodeURIComponent(id) + "/" + action, { method: "POST" });
      if (resp.status === 401) {
        setLcMsg({ kind: "err", text: "Bitte zuerst im Tab Einstellungen anmelden." });
        return;
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setLcMsg({ kind: "err", text: data.error || ("HTTP " + resp.status) });
        return;
      }
      setLcMsg({ kind: "ok", text: "Aktion ausgeführt." });
      reload(id);
      if (window.KNOWFLOW_FULL_RELOAD) window.KNOWFLOW_FULL_RELOAD();
    } catch (err) {
      setLcMsg({ kind: "err", text: err.message });
    }
  };

  if (!ticket) return null;
  const si = statusInfo(ticket.status);
  const view = detail || ticket;
  const lifecycle = view.lifecycle || "active";
  const access = window.KNOWFLOW_ACCESS || {};
  const canLifecycle = !!(access.permissions && access.permissions.manageLifecycle);

  const stepStatus = (i) => {
    const s = view.wf[i];
    return s === "done" ? "done" : s === "work" ? "work" : s === "err" ? "err" : "idle";
  };

  const stepTime = (i) => {
    const s = view.wf[i];
    if (s === "work") return "läuft...";
    if (s === "err") return "fehlgeschlagen";
    if (s === "idle") return "—";
    return (view.stepTimes && view.stepTimes[i]) || "abgeschlossen";
  };

  const stepSub = (i) => {
    const sub = view.subs && view.subs[i];
    if (sub) return sub;
    const s = view.wf[i];
    if (s === "done") return "abgeschlossen";
    if (s === "work") return "läuft...";
    if (s === "err") return view.error || "Fehler";
    return "wartet auf vorherigen Schritt";
  };

  return (
    <>
      <div className={"drawer-scrim " + (ticket ? "open" : "")} onClick={onClose}></div>
      <div className={"drawer " + (ticket ? "open" : "")}>
        <div className="drawer-head">
          <div style={{minWidth:0}}>
            <div className="tk-id-row" style={{marginBottom:6}}>
              <span className="tk-id">{view.id}</span>
              <span className={"tk-status-pill " + si.cls}>
                <span className="dot"></span>{si.label}
              </span>
            </div>
            <h3 style={{margin:0, fontSize:17, fontWeight:600, letterSpacing:"-.01em"}}>{view.title}</h3>
          </div>
          <button className="drawer-close" onClick={onClose}><i className="bi bi-x-lg"></i></button>
        </div>

        <div className="drawer-body">
          <div className="drawer-section">
            <h6>Metadaten</h6>
            <div className="kv-grid">
              <div><div className="k">Reporter</div><div className="v">{view.reporter || "—"}</div></div>
              <div><div className="k">Assignee</div><div className="v">{view.assignee || "—"}</div></div>
              <div><div className="k">Priorität</div><div className="v">{view.priority || "—"}</div></div>
              <div><div className="k">Jira-Status</div><div className="v">{view.jiraStatus || "—"}</div></div>
              <div><div className="k">Aktualisiert</div><div className="v">{view.updated}</div></div>
              <div><div className="k">OpenWebUI UUID</div><div className="v mono" style={{fontSize:11}}>{view.uuid || "—"}</div></div>
            </div>
          </div>

          <div className="drawer-section">
            <h6>Workflow</h6>
            <div className="wf-stepper">
              {STEP_NAMES.map((name, i) => (
                <div key={i} className={"wf-step " + stepStatus(i)}>
                  <div className="wf-dot">
                    {view.wf[i] === "done" ? <i className="bi bi-check-lg"></i>
                      : view.wf[i] === "err" ? <i className="bi bi-x-lg"></i>
                      : view.wf[i] === "work" ? <i className="bi bi-three-dots"></i>
                      : (i+1)}
                  </div>
                  <div>
                    <div className="wf-step-name">{name}</div>
                    <div className="wf-step-sub">{stepSub(i)}</div>
                  </div>
                  <div className="wf-step-time">{stepTime(i)}</div>
                </div>
              ))}
            </div>
          </div>

          {view.markdown && (
            <div className="drawer-section">
              <h6>Generiertes Wissens-Markdown</h6>
              <div className="md-preview">{view.markdown}</div>
              <div style={{display:"flex", gap:8, marginTop:12}}>
                <a
                  className="btn-ghost"
                  href={"data:text/markdown;charset=utf-8," + encodeURIComponent(view.markdown)}
                  download={view.id + ".md"}
                >
                  <i className="bi bi-download"></i>Markdown herunterladen
                </a>
                {view.uuid && (
                  <a className="btn-ghost" href={"/openwebui-dummy/api/v1/files/" + view.uuid} target="_blank" rel="noreferrer">
                    <i className="bi bi-arrow-up-right-square"></i>Dummy-Datei ansehen
                  </a>
                )}
              </div>
            </div>
          )}

          {view.status === "rework" && (
            <div className="drawer-section">
              <h6>Hinweis</h6>
              <div style={{
                background:"var(--rework-tint)",
                border:"1px solid #ddd6fe",
                borderRadius:8,
                padding:"12px 14px",
                fontSize:13,
                color:"#5b21b6",
                lineHeight:1.5
              }}>
                <i className="bi bi-info-circle" style={{marginRight:6}}></i>
                Dieses Ticket wurde auf <b>Überarbeiten</b> gesetzt. Sobald es wieder
                auf <b>Done</b> wechselt, wird die UUID in OpenWebUI mit dem aktualisierten
                Wissen überschrieben.
              </div>
            </div>
          )}

          {view.status === "err" && (
            <div className="drawer-section">
              <h6>Fehlerdetails</h6>
              <div style={{
                background:"var(--err-tint)",
                border:"1px solid #fecaca",
                borderRadius:8,
                padding:"12px 14px",
                fontSize:12.5,
                color:"#991b1b",
                fontFamily:"'JetBrains Mono', monospace",
                lineHeight:1.55,
                whiteSpace:"pre-wrap"
              }}>
                {view.error || "Unbekannter Fehler"}
              </div>
              <div style={{display:"flex", gap:8, marginTop:12}}>
                <button className="btn-primary-x" onClick={() => onRetry && onRetry(view.id)}>
                  <i className="bi bi-arrow-repeat"></i>Erneut versuchen
                </button>
              </div>
            </div>
          )}

          {view.attachments && view.attachments.length > 0 && (
            <div className="drawer-section">
              <h6>Anhänge</h6>
              <div style={{display:"flex", flexDirection:"column", gap:6}}>
                {view.attachments.map((a) => (
                  <a
                    key={a.id}
                    className="btn-ghost"
                    style={{justifyContent:"flex-start"}}
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <i className="bi bi-paperclip"></i>
                    <span style={{flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap"}}>{a.filename}</span>
                    <span style={{fontSize:11, color:"var(--muted)"}}>{humanizeFileSize(a.size)}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          <div className="drawer-section">
            <h6>Lebenszyklus</h6>
            {lcMsg && (
              <div style={{
                background: lcMsg.kind === "err" ? "var(--err-tint)" : "var(--ok-tint)",
                border: "1px solid " + (lcMsg.kind === "err" ? "#fecaca" : "#a7f3d0"),
                borderRadius: 8,
                padding: "8px 12px",
                fontSize: 12.5,
                color: lcMsg.kind === "err" ? "#991b1b" : "#065f46",
                marginBottom: 10
              }}>{lcMsg.text}</div>
            )}
            {lifecycle !== "active" && (
              <div style={{fontSize:12.5, color:"var(--muted)", marginBottom:10}}>
                Status: <b style={{color:"var(--ink-2)"}}>{lifecycle === "deleted" ? "Gelöscht" : "Veraltet"}</b>
              </div>
            )}
            {!canLifecycle ? (
              <div style={{fontSize:12.5, color:"var(--muted)"}}>
                Zum Ändern des Lebenszyklus bitte im Tab Einstellungen mit den nötigen Rechten anmelden.
              </div>
            ) : (
              <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
                {lifecycle === "active" ? (
                  <>
                    <button className="btn-ghost" onClick={() => lifecycleAction(view.id, "obsolete", "Dieses Ticket als veraltet markieren? Das Wissen wird aus allen Wissensbasen entfernt.")}>
                      <i className="bi bi-archive"></i>Obsolet
                    </button>
                    <button className="btn-ghost" style={{color:"var(--err)"}} onClick={() => lifecycleAction(view.id, "delete", "Dieses Ticket löschen? Das Wissen und die Dateien werden aus allen Wissensbasen entfernt.")}>
                      <i className="bi bi-trash"></i>Löschen
                    </button>
                  </>
                ) : (
                  <button className="btn-primary-x" onClick={() => lifecycleAction(view.id, "restore", "Dieses Ticket reaktivieren? Die Pipeline läuft erneut und baut das Wissen neu auf.")}>
                    <i className="bi bi-arrow-counterclockwise"></i>Reaktivieren
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Tickets() {
  window.useLiveData();
  const [filter, setFilter] = React.useState("all");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [active, setActive] = React.useState(null);

  const data = window.KNOWFLOW_DATA;
  const tickets = data.TICKETS || [];
  const total = data.TICKETS_TOTAL || 0;
  const perPage = data.TICKETS_PER_PAGE || 10;
  const counts = data.TICKETS_COUNTS || { all: 0, done: 0, work: 0, err: 0, rework: 0 };

  React.useEffect(() => {
    if (window.KNOWFLOW_RELOAD_TICKETS) {
      window.KNOWFLOW_RELOAD_TICKETS({ page, filter, q: query });
    }
  }, [page, filter, query]);

  React.useEffect(() => { setPage(1); }, [filter, query]);

  // Deep-link handling: when the page is opened with ?ticket=KEY, open the
  // drawer for that ticket on first mount. Uses a stub so the Drawer fetches
  // the full detail via /api/tickets/:id even when the ticket is not on the
  // currently visible page.
  React.useEffect(() => {
    const target = window.KNOWFLOW_DEEP_LINK_TICKET;
    if (!target) return;
    window.KNOWFLOW_DEEP_LINK_TICKET = null;
    setActive({ id: target, wf: ["idle", "idle", "idle"], status: "idle" });
  }, []);

  const pages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, pages);
  const slice = tickets;

  const chips = [
    { id: "all",    label: "Alle",              count: counts.all || 0,    dot: null },
    { id: "done",   label: "Done",              count: counts.done || 0,   dot: "var(--ok)" },
    { id: "work",   label: "In Arbeit",         count: counts.work || 0,   dot: "var(--warn)" },
    { id: "err",    label: "Fehler",            count: counts.err || 0,    dot: "var(--err)" },
    { id: "rework", label: "Wird Überarbeitet", count: counts.rework || 0, dot: "var(--rework)" },
  ];

  const onRetry = (id) => {
    if (window.KNOWFLOW_RETRY_TICKET) {
      window.KNOWFLOW_RETRY_TICKET(id);
    }
    setActive(null);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Tickets</h1>
          <p className="page-sub">{total} Tickets · Seite {safePage} von {pages}</p>
        </div>
        <div style={{display:"flex", gap:8}}>
          <button className="btn-ghost" onClick={() => window.KNOWFLOW_FULL_RELOAD && window.KNOWFLOW_FULL_RELOAD()}>
            <i className="bi bi-arrow-clockwise"></i>Aktualisieren
          </button>
        </div>
      </div>

      <div className="tickets-toolbar">
        <div className="search-input">
          <i className="bi bi-search"></i>
          <input
            type="text"
            placeholder="Nach Titel oder Ticket-ID suchen..."
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <div className="filter-chips">
          {chips.map(c => (
            <button
              key={c.id}
              className={"chip " + (filter === c.id ? "active" : "")}
              onClick={() => setFilter(c.id)}
            >
              {c.dot && <span className="dot" style={{background:c.dot}}></span>}
              {c.label}
              <span className="count">{c.count}</span>
            </button>
          ))}
        </div>
      </div>

      {slice.length === 0 ? (
        <div className="empty">
          <i className="bi bi-inbox"></i>
          <div>Keine Tickets gefunden. Sobald ein Jira-Webhook eintrifft, erscheinen Tickets hier.</div>
        </div>
      ) : (
        <div className="ticket-list">
          {slice.map(t => <TicketCard key={t.id} t={t} onOpen={setActive} />)}
        </div>
      )}

      {/* pagination */}
      {total > 0 && (
        <div className="pagination-bar">
          <div className="page-info">
            Zeige <b>{(safePage - 1) * perPage + 1}</b>–<b>{Math.min(safePage * perPage, total)}</b> von <b>{total}</b>
          </div>
          <div className="page-btns">
            <button className="page-btn" disabled={safePage === 1} onClick={() => setPage(safePage - 1)}>
              <i className="bi bi-chevron-left"></i>
            </button>
            {Array.from({length: pages}, (_, i) => i + 1).map(p => (
              <button
                key={p}
                className={"page-btn " + (p === safePage ? "active" : "")}
                onClick={() => setPage(p)}
              >{p}</button>
            ))}
            <button className="page-btn" disabled={safePage === pages} onClick={() => setPage(safePage + 1)}>
              <i className="bi bi-chevron-right"></i>
            </button>
          </div>
        </div>
      )}

      <Drawer ticket={active} onClose={() => setActive(null)} onRetry={onRetry} />
    </>
  );
}

window.Tickets = Tickets;
