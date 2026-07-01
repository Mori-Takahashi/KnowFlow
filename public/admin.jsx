// ============================================================
// Admin-Dashboard (geschützt per Login)
// ============================================================

// --- kleine API-Helfer (Cookies werden bei same-origin automatisch gesendet) ---
function adminApi(method, path, body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    headers["x-csrf-token"] = window.getCsrfToken ? window.getCsrfToken() : "";
  }
  return fetch("/api/admin" + path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
    return data;
  });
}

// Stellt bereit, ob die aktuelle Sitzung Einstellungen ändern darf. Editoren
// lesen canEdit hieraus, um Speichern-Buttons im Nur-Lese-Modus zu sperren.
const AdminCtx = React.createContext({ canEdit: true, isAdmin: true });

const LOGICAL_FIELD_LABELS = {
  description: "Beschreibung",
  solution: "Lösung",
  targetBot: "Ziel-Bot(s)",
  category: "Kategorie",
  label: "Stichwort(e)",
  hint: "Hinweis",
};

const OPERATOR_LABELS = {
  equals: "ist gleich",
  contains: "enthält",
  in: "ist eine von (Liste)",
  exists: "ist gesetzt",
};

function listToText(arr) {
  return (arr || []).join(", ");
}
function textToList(text) {
  return (text || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Wiederverwendbarer Text-Input im Stil der Debug-Inputs.
function Field({ label, value, onChange, type = "text", placeholder, disabled }) {
  return (
    <div style={{ marginBottom: 12 }}>
      {label && <div className="k" style={{ marginBottom: 6 }}>{label}</div>}
      <input
        type={type}
        value={value == null ? "" : value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "9px 12px",
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontSize: 13,
          opacity: disabled ? 0.5 : 1,
        }}
      />
    </div>
  );
}

function Banner({ kind, children }) {
  if (!children) return null;
  const styles = {
    ok: { bg: "var(--ok-tint)", bd: "#a7f3d0", fg: "#065f46", icon: "bi-check-circle" },
    err: { bg: "var(--err-tint)", bd: "#fecaca", fg: "#991b1b", icon: "bi-exclamation-octagon" },
    info: { bg: "var(--brand-tint)", bd: "#c7d2fe", fg: "#3730a3", icon: "bi-info-circle" },
  };
  const s = styles[kind] || styles.info;
  return (
    <div style={{ background: s.bg, border: "1px solid " + s.bd, borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: s.fg, display: "flex", alignItems: "center", gap: 8 }}>
      <i className={"bi " + s.icon}></i>
      <div>{children}</div>
    </div>
  );
}

// ============================================================
// Login-Gate
// ============================================================
function AdminLogin({ onSuccess }) {
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminApi("POST", "/login", { password });
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title"><i className="bi bi-shield-lock" style={{ marginRight: 8 }}></i>Anmeldung erforderlich</h1>
          <p className="page-sub">Bitte mit dem Admin- oder Benutzer-Passwort anmelden.</p>
        </div>
      </div>
      <div className="card-x" style={{ maxWidth: 420 }}>
        <div className="card-head"><h6>Anmeldung</h6></div>
        <div className="card-body-x">
          <Banner kind="err">{error}</Banner>
          <Field
            label="Passwort"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="Passwort"
          />
          <button className="btn-primary-x" disabled={busy || !password} onClick={submit}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}>
            <i className="bi bi-box-arrow-in-right"></i>{busy ? "Anmelden..." : "Anmelden"}
          </button>
        </div>
      </div>
    </>
  );
}

// ============================================================
// Vollbild-Sperrbildschirm (gesamtes Dashboard gesperrt)
// ============================================================
function LockScreen({ onSuccess, userLoginEnabled }) {
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi("POST", "/login", { password });
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--bg, #0f172a)",
      padding: 20
    }}>
      <div style={{ width: "100%", maxWidth: 400 }}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div className="brand-mark" style={{ margin: "0 auto 12px", width: 48, height: 48, fontSize: 18 }}>JB</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--ink, #e2e8f0)", margin: 0 }}>KnowFlow</h1>
          <p style={{ fontSize: 13, color: "var(--muted, #94a3b8)", marginTop: 6 }}>
            <i className="bi bi-lock-fill" style={{ marginRight: 6 }}></i>
            Dieses Dashboard ist geschützt. Bitte anmelden.
          </p>
        </div>
        <div className="card-x">
          <div className="card-body-x">
            <Banner kind="err">{error}</Banner>
            <Field
              label="Passwort"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder={userLoginEnabled ? "Admin- oder Benutzer-Passwort" : "Admin-Passwort"}
            />
            <button className="btn-primary-x" style={{ width: "100%", justifyContent: "center" }}
              disabled={busy || !password} onClick={submit}>
              <i className="bi bi-box-arrow-in-right"></i>{busy ? "Anmelden..." : "Anmelden"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

window.LockScreen = LockScreen;

// ============================================================
// Tab: Allgemein (Jira-Verbindung + OpenWebUI-Modus)
// ============================================================
function AdminGeneral({ config, reloadConfig }) {
  const { canEdit } = React.useContext(AdminCtx);
  const j = config.jira;
  const [baseUrl, setBaseUrl] = React.useState(j.baseUrl || "");
  const [email, setEmail] = React.useState(j.email || "");
  const [apiToken, setApiToken] = React.useState("");
  const [projectKeys, setProjectKeys] = React.useState(listToText(j.projectKeys));
  const [doneStatuses, setDoneStatuses] = React.useState(listToText(j.doneStatuses));
  const [reworkStatuses, setReworkStatuses] = React.useState(listToText(j.reworkStatuses));
  const [webhookSecret, setWebhookSecret] = React.useState("");
  const [apiTokenExpiresAt, setApiTokenExpiresAt] = React.useState(j.apiTokenExpiresAt || "");
  const [msg, setMsg] = React.useState(null);
  const [testMsg, setTestMsg] = React.useState(null);

  const save = async () => {
    setMsg(null);
    try {
      const body = {
        baseUrl,
        email,
        projectKeys: textToList(projectKeys),
        doneStatuses: textToList(doneStatuses),
        reworkStatuses: textToList(reworkStatuses),
        apiTokenExpiresAt,
      };
      if (apiToken) body.apiToken = apiToken;
      if (webhookSecret) body.webhookSecret = webhookSecret;
      await adminApi("PUT", "/config/jira", body);
      setApiToken("");
      setWebhookSecret("");
      setMsg({ kind: "ok", text: "Jira-Einstellungen gespeichert." });
      reloadConfig();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  const testConn = async () => {
    setTestMsg({ kind: "info", text: "Teste Verbindung..." });
    try {
      const r = await adminApi("POST", "/jira/test", {});
      setTestMsg({ kind: r.status === "down" ? "err" : "ok", text: `Status: ${r.statusLabel} (${r.latencyMs} ms)` });
    } catch (err) {
      setTestMsg({ kind: "err", text: err.message });
    }
  };

  const setMode = async (mode) => {
    try {
      await adminApi("PUT", "/config/openwebui-mode", { mode });
      reloadConfig();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  return (
    <>
      <div className="card-x" style={{ marginBottom: 16 }}>
        <div className="card-head"><h6>Jira-Verbindung</h6>
          <button className="btn-ghost" style={{ padding: "5px 10px" }} onClick={testConn}><i className="bi bi-plug"></i>Verbindung testen</button>
        </div>
        <div className="card-body-x">
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
          {testMsg && <Banner kind={testMsg.kind}>{testMsg.text}</Banner>}
          <Field label="Base URL" value={baseUrl} onChange={setBaseUrl} placeholder="https://workspace.atlassian.net" />
          <Field label="E-Mail" value={email} onChange={setEmail} placeholder="user@example.com" />
          <Field
            label={"API-Token" + (j.hasApiToken ? " (gesetzt — leer lassen, um beizubehalten)" : "")}
            type="password"
            value={apiToken}
            onChange={setApiToken}
            placeholder={j.hasApiToken ? "•••••••• gespeichert" : "Jira API-Token"}
          />
          <Field
            label="Ablaufdatum des API-Tokens (optional)"
            type="date"
            value={apiTokenExpiresAt}
            onChange={setApiTokenExpiresAt}
          />
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: -6, marginBottom: 12 }}>
            10 Tage vor Ablauf erscheint eine Warnung im Dashboard. Leer lassen, um die Erinnerung zu deaktivieren.
          </div>
          <Field label="Projekt-Schlüssel (kommagetrennt)" value={projectKeys} onChange={setProjectKeys} placeholder="KAN, KNOW" />
          <Field label="Done-Status (kommagetrennt)" value={doneStatuses} onChange={setDoneStatuses} placeholder="Done, Fertig" />
          <Field label="Überarbeiten-Status (kommagetrennt)" value={reworkStatuses} onChange={setReworkStatuses} placeholder="Überarbeiten" />
          <Field
            label={"Webhook-Secret" + (j.hasWebhookSecret ? " (gesetzt — leer lassen, um beizubehalten)" : "")}
            type="password"
            value={webhookSecret}
            onChange={setWebhookSecret}
            placeholder={j.hasWebhookSecret ? "•••••••• gespeichert" : "optional"}
          />
          <button className="btn-primary-x" onClick={save} disabled={!canEdit}><i className="bi bi-save"></i>Speichern</button>
        </div>
      </div>

      <div className="card-x">
        <div className="card-head"><h6>OpenWebUI-Modus</h6></div>
        <div className="card-body-x">
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
            Im <b>Dummy-Modus</b> werden keine echten OpenWebUI-Aufrufe gemacht (lokaler Mock, für Tests/Demos).
            Im <b>Real-Modus</b> werden die konfigurierten Wissensbasen tatsächlich angesprochen.
          </p>
          <div className="filter-chips">
            {["dummy", "real"].map((m) => (
              <button key={m} className={"chip " + (config.openwebuiMode === m ? "active" : "")} disabled={!canEdit} onClick={() => setMode(m)}>
                {m === "dummy" ? "Dummy" : "Real"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================
// Tab: RAG (semantische Suche via Embeddings)
// ============================================================
function AdminRag({ config, reloadConfig }) {
  const { canEdit } = React.useContext(AdminCtx);
  const r = config.rag || { mode: "off", ollamaUrl: "http://localhost:11434", model: "", dim: 0 };
  const [mode, setMode] = React.useState(r.mode || "off");
  const [ollamaUrl, setOllamaUrl] = React.useState(r.ollamaUrl || "http://localhost:11434");
  const [model, setModel] = React.useState(r.model || "");
  const [openaiApiKey, setOpenaiApiKey] = React.useState("");
  const [msg, setMsg] = React.useState(null);
  const [testMsg, setTestMsg] = React.useState(null);
  const [status, setStatus] = React.useState(null);

  const loadStatus = React.useCallback(() => {
    adminApi("GET", "/config/rag/status").then(setStatus).catch(() => {});
  }, []);

  React.useEffect(() => { loadStatus(); }, [loadStatus]);

  // While a reindex runs, poll the status so the progress bar advances live.
  React.useEffect(() => {
    if (!status || !status.running) return undefined;
    const id = setInterval(loadStatus, 1500);
    return () => clearInterval(id);
  }, [status, loadStatus]);

  const save = async () => {
    setMsg(null);
    try {
      const body = { mode, ollamaUrl, model };
      // Local mode reuses the model field; fall back to the bundled default so
      // the stored model tag matches what the server actually embeds with.
      if (mode === "local" && !model.trim()) body.model = "Xenova/multilingual-e5-small";
      if (openaiApiKey) body.openaiApiKey = openaiApiKey;
      await adminApi("PUT", "/config/rag", body);
      setOpenaiApiKey("");
      setMsg({ kind: "ok", text: "RAG-Einstellungen gespeichert. Nutze 'Alle neu indizieren', um bestehende Tickets zu erfassen." });
      reloadConfig();
      loadStatus();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  const testConn = async () => {
    setTestMsg({ kind: "info", text: "Teste Embedding-Dienst..." });
    try {
      const res = await adminApi("POST", "/config/rag/test", {});
      setTestMsg({ kind: "ok", text: `OK — Modell ${res.model}, ${res.dim} Dimensionen.` });
    } catch (err) {
      setTestMsg({ kind: "err", text: err.message });
    }
  };

  const reindex = async () => {
    setMsg(null);
    try {
      await adminApi("POST", "/config/rag/reindex", {});
      setMsg({ kind: "info", text: "Re-Indizierung gestartet..." });
      loadStatus();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  const MODES = [
    { id: "off", label: "Aus (nur Stichwort)" },
    { id: "local", label: "Lokal (im Server)" },
    { id: "openai", label: "OpenAI" },
    { id: "ollama", label: "Ollama (lokal)" },
  ];
  const prog = status && status.progress;
  const pct = prog && prog.total > 0 ? Math.round(((prog.done + prog.failed) / prog.total) * 100) : 0;

  return (
    <>
      <div className="card-x" style={{ marginBottom: 16 }}>
        <div className="card-head"><h6>Semantische Suche (RAG)</h6>
          {mode !== "off" && <button className="btn-ghost" style={{ padding: "5px 10px" }} onClick={testConn}><i className="bi bi-plug"></i>Verbindung testen</button>}
        </div>
        <div className="card-body-x">
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
          {testMsg && <Banner kind={testMsg.kind}>{testMsg.text}</Banner>}
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
            Ist RAG aktiv, wird der Ticket-Text beim Speichern in einen Vektor umgewandelt. Das MCP-Tool
            <b> search_knowledge</b> kombiniert dann semantische Treffer mit der bestehenden Stichwortsuche
            (Hybrid). Bei „Aus" bleibt es bei der reinen Stichwortsuche.
          </p>
          <div className="filter-chips" style={{ marginBottom: 12 }}>
            {MODES.map((m) => (
              <button key={m.id} className={"chip " + (mode === m.id ? "active" : "")} disabled={!canEdit} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>

          {mode === "local" && (
            <>
              <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
                Embeddings werden direkt im KnowFlow-Server berechnet (Transformers.js) — kein
                externer Dienst und keine GPU nötig. Ideal für mittelstarke Server. Das Modell wird
                beim ersten Einsatz einmalig heruntergeladen und zwischengespeichert.
              </p>
              <Field label="Modell" value={model} onChange={setModel} placeholder="Xenova/multilingual-e5-small" />
            </>
          )}
          {mode === "ollama" && (
            <>
              <Field label="Ollama URL" value={ollamaUrl} onChange={setOllamaUrl} placeholder="http://localhost:11434" />
              <Field label="Modell" value={model} onChange={setModel} placeholder="nomic-embed-text" />
            </>
          )}
          {mode === "openai" && (
            <>
              <Field label="Modell" value={model} onChange={setModel} placeholder="text-embedding-3-small" />
              <Field
                label={"OpenAI API-Key" + (r.hasOpenaiApiKey ? " (gesetzt — leer lassen, um beizubehalten)" : "")}
                type="password"
                value={openaiApiKey}
                onChange={setOpenaiApiKey}
                placeholder={r.hasOpenaiApiKey ? "•••••••• gespeichert" : "sk-..."}
              />
            </>
          )}
          {mode !== "off" && (
            <button className="btn-primary-x" onClick={save} disabled={!canEdit}><i className="bi bi-save"></i>Speichern</button>
          )}
          {mode === "off" && (
            <button className="btn-primary-x" onClick={save} disabled={!canEdit}><i className="bi bi-save"></i>Speichern (deaktivieren)</button>
          )}
        </div>
      </div>

      {status && status.enabled && (
        <div className="card-x">
          <div className="card-head"><h6>Indexierung</h6>
            <button className="btn-ghost" style={{ padding: "5px 10px" }} onClick={reindex} disabled={!canEdit || status.running}>
              <i className="bi bi-arrow-repeat"></i>{status.running ? "Läuft..." : "Alle neu indizieren"}
            </button>
          </div>
          <div className="card-body-x">
            <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
              {status.stats.embedded} von {status.stats.total} aktiven Tickets sind eingebettet
              {status.stats.failed > 0 ? `, ${status.stats.failed} fehlgeschlagen` : ""}.
            </p>
            {status.running && prog && (
              <>
                <div style={{ height: 8, background: "var(--border)", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
                  <div style={{ width: pct + "%", height: "100%", background: "var(--brand, #6366f1)" }}></div>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)" }}>{prog.done + prog.failed} / {prog.total} verarbeitet</div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================
// Tab: Schneller Chat
// ============================================================
function AdminQuickChat({ targets }) {
  const { canEdit } = React.useContext(AdminCtx);
  const [cfg, setCfg] = React.useState(null);
  const [enabled, setEnabled] = React.useState(false);
  const [targetId, setTargetId] = React.useState("");
  const [attachKnowledge, setAttachKnowledge] = React.useState(true);
  const [systemPrompt, setSystemPrompt] = React.useState("");
  const [allowedModels, setAllowedModels] = React.useState([]);
  const [models, setModels] = React.useState([]);
  const [modelsMsg, setModelsMsg] = React.useState(null);
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [msg, setMsg] = React.useState(null);

  React.useEffect(() => {
    adminApi("GET", "/config/quickchat")
      .then((c) => {
        setCfg(c);
        setEnabled(Boolean(c.enabled));
        setTargetId(c.targetId || "");
        setAttachKnowledge(c.attachKnowledge !== false);
        setSystemPrompt(c.systemPrompt || "");
        setAllowedModels(Array.isArray(c.allowedModels) ? c.allowedModels : []);
      })
      .catch((e) => setMsg({ kind: "err", text: e.message }));
  }, []);

  const loadModels = async () => {
    if (!targetId) { setModelsMsg({ kind: "err", text: "Bitte zuerst eine Wissensbasis wählen." }); return; }
    setLoadingModels(true);
    setModelsMsg({ kind: "info", text: "Lade Modelle..." });
    try {
      const d = await adminApi("GET", "/config/quickchat/models?targetId=" + encodeURIComponent(targetId));
      setModels(d.models || []);
      setModelsMsg({ kind: "ok", text: (d.models || []).length + " Modelle gefunden." });
    } catch (err) {
      setModels([]);
      setModelsMsg({ kind: "err", text: err.message });
    } finally {
      setLoadingModels(false);
    }
  };

  const toggleModel = (id) => {
    setAllowedModels((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));
  };

  const save = async () => {
    setMsg(null);
    try {
      await adminApi("PUT", "/config/quickchat", { enabled, targetId, attachKnowledge, systemPrompt, allowedModels });
      setMsg({ kind: "ok", text: "Schneller-Chat-Einstellungen gespeichert. Der Tab erscheint nach dem Neuladen des Dashboards." });
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  if (!cfg) return <div className="empty"><i className="bi bi-hourglass"></i><div>Lade...</div></div>;

  const modelIds = models.map((m) => m.id);
  const extraAllowed = allowedModels.filter((m) => !modelIds.includes(m));
  const inputStyle = { width: "100%", padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13, marginBottom: 12 };

  return (
    <div className="card-x">
      <div className="card-head"><h6>Schneller Chat</h6></div>
      <div className="card-body-x">
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
          Aktiviert einen temporären Chat im Dashboard, den jeder Besucher nutzen kann. Er läuft über
          den OpenWebUI-API-Key der gewählten Wissensbasis und bezieht sein Wissen aus deren
          Knowledge-Collection. Unterhaltungen werden nicht gespeichert. Erfordert den „Real"-Modus.
        </p>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 13 }}>
          <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} />
          Schnellen Chat aktivieren
        </label>

        <div className="k" style={{ marginBottom: 6 }}>Wissensbasis (Chat-Backend)</div>
        <select value={targetId} disabled={!canEdit} onChange={(e) => setTargetId(e.target.value)} style={inputStyle}>
          <option value="">— auswählen —</option>
          {(targets || []).map((t) => (
            <option key={t.id} value={t.id}>{t.name}{t.enabled ? "" : " (deaktiviert)"}</option>
          ))}
        </select>

        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 13 }}>
          <input type="checkbox" checked={attachKnowledge} disabled={!canEdit} onChange={(e) => setAttachKnowledge(e.target.checked)} />
          Wissensbasis an jede Anfrage anhängen (RAG)
        </label>

        <div className="k" style={{ marginBottom: 6 }}>System-Prompt</div>
        <textarea
          value={systemPrompt}
          disabled={!canEdit}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={4}
          placeholder="z. B. Du bist der KnowFlow-Assistent und antwortest nur anhand der Wissensbasis..."
          style={{ ...inputStyle, marginBottom: 16, fontFamily: "inherit", resize: "vertical" }}
        />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div className="k">Erlaubte Modelle</div>
          <button className="btn-ghost" style={{ padding: "5px 10px" }} disabled={!canEdit || loadingModels || !targetId} onClick={loadModels}>
            <i className="bi bi-arrow-repeat"></i>{loadingModels ? "Lädt..." : "Modelle laden"}
          </button>
        </div>
        {modelsMsg && <Banner kind={modelsMsg.kind}>{modelsMsg.text}</Banner>}
        {models.length === 0 && extraAllowed.length === 0 && (
          <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Noch keine Modelle geladen. Wähle eine Wissensbasis und klicke „Modelle laden".</p>
        )}
        {(models.length > 0 || extraAllowed.length > 0) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
            {models.map((m) => (
              <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={allowedModels.includes(m.id)} disabled={!canEdit} onChange={() => toggleModel(m.id)} />
                {m.name || m.id}<span style={{ color: "var(--muted-2)", fontSize: 11 }}>{m.id}</span>
              </label>
            ))}
            {extraAllowed.map((id) => (
              <label key={id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, opacity: 0.8 }}>
                <input type="checkbox" checked disabled={!canEdit} onChange={() => toggleModel(id)} />
                {id}<span style={{ color: "var(--muted-2)", fontSize: 11 }}>(nicht in der geladenen Liste)</span>
              </label>
            ))}
          </div>
        )}

        <button className="btn-primary-x" onClick={save} disabled={!canEdit}><i className="bi bi-save"></i>Speichern</button>
      </div>
    </div>
  );
}

// ============================================================
// Tab: Feld-Zuordnung
// ============================================================
function AdminFieldMapping({ config, fields, fieldsError, reloadConfig }) {
  const { canEdit } = React.useContext(AdminCtx);
  const [mappings, setMappings] = React.useState(config.fieldMappings || {});
  const [msg, setMsg] = React.useState(null);

  const set = (logical, fieldId) => setMappings((m) => ({ ...m, [logical]: fieldId }));

  const save = async () => {
    setMsg(null);
    try {
      await adminApi("PUT", "/field-mappings", mappings);
      setMsg({ kind: "ok", text: "Feld-Zuordnung gespeichert." });
      reloadConfig();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  return (
    <div className="card-x">
      <div className="card-head"><h6>Jira-Felder zuordnen</h6></div>
      <div className="card-body-x">
        <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
          Ordne jedem Logik-Feld das passende Jira-Feld zu. Beschreibung und Lösung werden daraus
          sauber getrennt in das Markdown übernommen; das Feld „Ziel-Bot(s)" steuert das Routing.
        </p>
        {fieldsError && <Banner kind="err">Jira-Felder konnten nicht geladen werden: {fieldsError}. Bitte zuerst die Jira-Verbindung unter „Allgemein" konfigurieren.</Banner>}
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        {(config.logicalFields || []).map((lf) => (
          <div key={lf} style={{ marginBottom: 12 }}>
            <div className="k" style={{ marginBottom: 6 }}>{LOGICAL_FIELD_LABELS[lf] || lf}</div>
            <select
              value={mappings[lf] || ""}
              onChange={(e) => set(lf, e.target.value)}
              style={{ width: "100%", padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13, background: "#fff" }}
            >
              <option value="">— nicht zugeordnet —</option>
              {(fields || []).map((f) => (
                <option key={f.id} value={f.id}>{f.name} ({f.id})</option>
              ))}
            </select>
          </div>
        ))}
        <button className="btn-primary-x" onClick={save} disabled={!canEdit}><i className="bi bi-save"></i>Speichern</button>
      </div>
    </div>
  );
}

// ============================================================
// Tab: Wissensbasen / Bots
// ============================================================
function TargetEditor({ target, onSaved, onCancel }) {
  const { canEdit } = React.useContext(AdminCtx);
  const isNew = !target.id;
  const [name, setName] = React.useState(target.name || "");
  const [url, setUrl] = React.useState(target.url || "");
  const [token, setToken] = React.useState("");
  const [knowledgeId, setKnowledgeId] = React.useState(target.knowledgeId || "");
  const [enabled, setEnabled] = React.useState(target.enabled !== false);
  const [msg, setMsg] = React.useState(null);

  const save = async () => {
    setMsg(null);
    try {
      const body = { name, url, knowledgeId, enabled };
      if (token) body.token = token;
      if (isNew) await adminApi("POST", "/targets", body);
      else await adminApi("PUT", "/targets/" + target.id, body);
      onSaved();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, marginBottom: 12, background: "var(--brand-tint)" }}>
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      <Field label="Name" value={name} onChange={setName} placeholder="z. B. Bot A / Support-Bot" />
      <Field label="OpenWebUI URL" value={url} onChange={setUrl} placeholder="https://chat.example.com" />
      <Field
        label={"API-Token" + (target.hasToken ? " (gesetzt — leer lassen, um beizubehalten)" : "")}
        type="password"
        value={token}
        onChange={setToken}
        placeholder={target.hasToken ? "•••••••• gespeichert" : "Bearer-Token"}
      />
      <Field label="Knowledge-ID" value={knowledgeId} onChange={setKnowledgeId} placeholder="UUID der Wissensbasis" />
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12, cursor: "pointer" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Aktiv
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-primary-x" onClick={save} disabled={!canEdit}><i className="bi bi-save"></i>Speichern</button>
        <button className="btn-ghost" onClick={onCancel}>Abbrechen</button>
      </div>
    </div>
  );
}

function AdminTargets({ config, targets, reloadTargets, reloadConfig }) {
  const { canEdit } = React.useContext(AdminCtx);
  const [editing, setEditing] = React.useState(null); // target object or {} for new
  const [testResult, setTestResult] = React.useState({});
  const fallback = config.fallbackTargetIds || [];

  const remove = async (id) => {
    if (!window.confirm("Diese Wissensbasis wirklich löschen?")) return;
    await adminApi("DELETE", "/targets/" + id);
    reloadTargets();
    reloadConfig();
  };

  const test = async (id) => {
    setTestResult((r) => ({ ...r, [id]: { kind: "info", text: "Teste..." } }));
    try {
      const res = await adminApi("POST", "/targets/" + id + "/test", {});
      setTestResult((r) => ({ ...r, [id]: { kind: res.status === "down" ? "err" : "ok", text: `${res.statusLabel} (${res.latencyMs} ms)` } }));
    } catch (err) {
      setTestResult((r) => ({ ...r, [id]: { kind: "err", text: err.message } }));
    }
  };

  const toggleFallback = async (id) => {
    const next = fallback.includes(id) ? fallback.filter((x) => x !== id) : [...fallback, id];
    await adminApi("PUT", "/fallback-targets", { targetIds: next });
    reloadConfig();
  };

  return (
    <div className="card-x">
      <div className="card-head"><h6>Wissensbasen / Bots</h6>
        {canEdit && <button className="btn-ghost" style={{ padding: "5px 10px" }} onClick={() => setEditing({})}><i className="bi bi-plus-lg"></i>Hinzufügen</button>}
      </div>
      <div className="card-body-x">
        <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
          Jede Wissensbasis ist ein Ziel (eigene OpenWebUI-Instanz oder eigene Knowledge-ID). Markiere als
          <b> Fallback</b>, was verwendet werden soll, wenn keine Routing-Regel zutrifft.
        </p>
        {editing && !editing.id && <TargetEditor target={editing} onSaved={() => { setEditing(null); reloadTargets(); }} onCancel={() => setEditing(null)} />}
        {targets.length === 0 && !editing && (
          <div className="empty" style={{ padding: "20px 0" }}><i className="bi bi-hdd-stack"></i><div>Noch keine Wissensbasis konfiguriert.</div></div>
        )}
        {targets.map((t) => (
          editing && editing.id === t.id ? (
            <TargetEditor key={t.id} target={t} onSaved={() => { setEditing(null); reloadTargets(); }} onCancel={() => setEditing(null)} />
          ) : (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{t.name}</span>
                  {!t.enabled && <span className="tk-id" style={{ fontSize: 10 }}>inaktiv</span>}
                  {fallback.includes(t.id) && <span className="tk-status-pill rework" style={{ fontSize: 10, padding: "2px 7px" }}><span className="dot"></span>Fallback</span>}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.url || "(keine URL)"} · KB: {t.knowledgeId || "—"} · Token: {t.hasToken ? "gesetzt" : "—"}
                </div>
                {testResult[t.id] && <div style={{ fontSize: 11.5, marginTop: 4, color: testResult[t.id].kind === "err" ? "var(--err)" : "var(--ok)" }}>{testResult[t.id].text}</div>}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {canEdit && <button className="btn-ghost" style={{ padding: "5px 9px" }} onClick={() => toggleFallback(t.id)} title="Als Fallback (de)markieren"><i className="bi bi-pin-angle"></i></button>}
                <button className="btn-ghost" style={{ padding: "5px 9px" }} onClick={() => test(t.id)} title="Testen"><i className="bi bi-plug"></i></button>
                {canEdit && <button className="btn-ghost" style={{ padding: "5px 9px" }} onClick={() => setEditing(t)} title="Bearbeiten"><i className="bi bi-pencil"></i></button>}
                {canEdit && <button className="btn-ghost" style={{ padding: "5px 9px", color: "var(--err)" }} onClick={() => remove(t.id)} title="Löschen"><i className="bi bi-trash"></i></button>}
              </div>
            </div>
          )
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Tab: Routing-Regeln
// ============================================================
function RuleEditor({ rule, config, targets, mcpConnections, onSaved, onCancel }) {
  const { canEdit } = React.useContext(AdminCtx);
  const isNew = !rule.id;
  const [name, setName] = React.useState(rule.name || "");
  const [enabled, setEnabled] = React.useState(rule.enabled !== false);
  const [conditions, setConditions] = React.useState(rule.conditions && rule.conditions.length ? rule.conditions : [{ field: "targetBot", operator: "contains", value: "" }]);
  const [ignoreConditions, setIgnoreConditions] = React.useState(rule.ignoreConditions || []);
  const [targetIds, setTargetIds] = React.useState(rule.targetIds || []);
  const [mcpIds, setMcpIds] = React.useState(rule.mcpIds || []);
  const [msg, setMsg] = React.useState(null);

  const fields = config.logicalFields || [];
  const operators = config.operators || [];
  const mcps = mcpConnections || [];

  const setCond = (i, patch) => setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addCond = () => setConditions((cs) => [...cs, { field: fields[0] || "targetBot", operator: "contains", value: "" }]);
  const removeCond = (i) => setConditions((cs) => cs.filter((_, idx) => idx !== i));
  const setIgnoreCond = (i, patch) => setIgnoreConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addIgnoreCond = () => setIgnoreConditions((cs) => [...cs, { field: fields[0] || "label", operator: "contains", value: "" }]);
  const removeIgnoreCond = (i) => setIgnoreConditions((cs) => cs.filter((_, idx) => idx !== i));
  const toggleTarget = (id) => setTargetIds((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));
  const toggleMcp = (id) => setMcpIds((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  const save = async () => {
    setMsg(null);
    try {
      const body = { name, enabled, conditions, ignoreConditions, targetIds, mcpIds };
      if (isNew) await adminApi("POST", "/rules", body);
      else await adminApi("PUT", "/rules/" + rule.id, body);
      onSaved();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14, marginBottom: 12, background: "var(--brand-tint)" }}>
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      <Field label="Regelname" value={name} onChange={setName} placeholder="z. B. Quelle X → Bot A" />

      <div className="k" style={{ marginBottom: 6 }}>Bedingungen (alle müssen zutreffen)</div>
      {conditions.map((c, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.2fr auto", gap: 6, marginBottom: 6, alignItems: "center" }}>
          <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value })} style={{ padding: "8px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12.5 }}>
            {fields.map((f) => <option key={f} value={f}>{LOGICAL_FIELD_LABELS[f] || f}</option>)}
          </select>
          <select value={c.operator} onChange={(e) => setCond(i, { operator: e.target.value })} style={{ padding: "8px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12.5 }}>
            {operators.map((o) => <option key={o} value={o}>{OPERATOR_LABELS[o] || o}</option>)}
          </select>
          <input
            value={c.value || ""}
            placeholder={c.operator === "exists" ? "(nicht nötig)" : "Wert"}
            disabled={c.operator === "exists"}
            onChange={(e) => setCond(i, { value: e.target.value })}
            style={{ padding: "8px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12.5, opacity: c.operator === "exists" ? 0.5 : 1 }}
          />
          <button className="btn-ghost" style={{ padding: "5px 8px" }} onClick={() => removeCond(i)} disabled={conditions.length <= 1}><i className="bi bi-x-lg"></i></button>
        </div>
      ))}
      <button className="btn-ghost" style={{ padding: "5px 10px", marginBottom: 12 }} onClick={addCond}><i className="bi bi-plus-lg"></i>Bedingung</button>

      <div className="k" style={{ marginBottom: 2 }}>Ignorieren (alle müssen zutreffen)</div>
      <p style={{ fontSize: 11.5, color: "var(--muted)", margin: "0 0 6px" }}>
        Trifft das hier zu, wird die Regel für dieses Ticket übersprungen – so lässt sich z. B. ein einzelnes Label/Tag ausnehmen, ohne alle anderen aufzählen zu müssen. Leer = nichts wird ignoriert.
      </p>
      {ignoreConditions.map((c, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.2fr auto", gap: 6, marginBottom: 6, alignItems: "center" }}>
          <select value={c.field} onChange={(e) => setIgnoreCond(i, { field: e.target.value })} style={{ padding: "8px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12.5 }}>
            {fields.map((f) => <option key={f} value={f}>{LOGICAL_FIELD_LABELS[f] || f}</option>)}
          </select>
          <select value={c.operator} onChange={(e) => setIgnoreCond(i, { operator: e.target.value })} style={{ padding: "8px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12.5 }}>
            {operators.map((o) => <option key={o} value={o}>{OPERATOR_LABELS[o] || o}</option>)}
          </select>
          <input
            value={c.value || ""}
            placeholder={c.operator === "exists" ? "(nicht nötig)" : "Wert"}
            disabled={c.operator === "exists"}
            onChange={(e) => setIgnoreCond(i, { value: e.target.value })}
            style={{ padding: "8px", border: "1px solid var(--border)", borderRadius: 7, fontSize: 12.5, opacity: c.operator === "exists" ? 0.5 : 1 }}
          />
          <button className="btn-ghost" style={{ padding: "5px 8px" }} onClick={() => removeIgnoreCond(i)}><i className="bi bi-x-lg"></i></button>
        </div>
      ))}
      <button className="btn-ghost" style={{ padding: "5px 10px", marginBottom: 12 }} onClick={addIgnoreCond}><i className="bi bi-plus-lg"></i>Ignorieren-Bedingung</button>

      <div className="k" style={{ marginBottom: 6 }}>Ziel-Wissensbasen</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {targets.length === 0 && <span style={{ fontSize: 12, color: "var(--muted)" }}>Zuerst Wissensbasen anlegen.</span>}
        {targets.map((t) => (
          <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 7, cursor: "pointer", background: targetIds.includes(t.id) ? "#fff" : "transparent" }}>
            <input type="checkbox" checked={targetIds.includes(t.id)} onChange={() => toggleTarget(t.id)} />{t.name}
          </label>
        ))}
      </div>

      <div className="k" style={{ marginBottom: 6 }}>MCP-Verbindungen</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {mcps.length === 0 && <span style={{ fontSize: 12, color: "var(--muted)" }}>Keine MCP-Verbindungen verfügbar.</span>}
        {mcps.map((m) => (
          <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, padding: "5px 10px", border: "1px solid var(--border)", borderRadius: 7, cursor: "pointer", background: mcpIds.includes(m.id) ? "#fff" : "transparent" }}>
            <input type="checkbox" checked={mcpIds.includes(m.id)} onChange={() => toggleMcp(m.id)} />{m.title}
          </label>
        ))}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12, cursor: "pointer" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Aktiv
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-primary-x" onClick={save} disabled={!canEdit}><i className="bi bi-save"></i>Speichern</button>
        <button className="btn-ghost" onClick={onCancel}>Abbrechen</button>
      </div>
    </div>
  );
}

function AdminRouting({ config, targets, mcpConnections, rules, reloadRules }) {
  const { canEdit } = React.useContext(AdminCtx);
  const [editing, setEditing] = React.useState(null);
  const [previewKey, setPreviewKey] = React.useState("");
  const [preview, setPreview] = React.useState(null);
  const targetName = (id) => (targets.find((t) => t.id === id) || {}).name || id;
  const mcpName = (id) => ((mcpConnections || []).find((m) => m.id === id) || {}).title || id;

  const remove = async (id) => {
    if (!window.confirm("Diese Regel wirklich löschen?")) return;
    await adminApi("DELETE", "/rules/" + id);
    reloadRules();
  };

  const runPreview = async () => {
    setPreview({ kind: "info", text: "Lade Ticket..." });
    try {
      const r = await adminApi("GET", "/rules/preview?issueKey=" + encodeURIComponent(previewKey.trim()));
      const mcpPart = (r.mcpConnectionIds && r.mcpConnectionIds.length)
        ? ` · MCP: ${r.mcpConnectionIds.map(mcpName).join(", ")}`
        : "";
      setPreview({
        kind: "ok",
        text: `${r.issueKey}: ${r.targets.map((t) => t.name).join(", ") || "kein Ziel"}` +
          (r.usedFallback ? " (Fallback)" : r.matchedRules.length ? ` · Regeln: ${r.matchedRules.join(", ")}` : "") +
          mcpPart,
      });
    } catch (err) {
      setPreview({ kind: "err", text: err.message });
    }
  };

  return (
    <>
      <div className="card-x" style={{ marginBottom: 16 }}>
        <div className="card-head"><h6>Routing-Regeln</h6>
          {canEdit && <button className="btn-ghost" style={{ padding: "5px 10px" }} onClick={() => setEditing({})}><i className="bi bi-plus-lg"></i>Regel hinzufügen</button>}
        </div>
        <div className="card-body-x">
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
            „Wenn Feld X Operator Y Wert Z → Wissensbasis(en)". Es greifen alle zutreffenden Regeln; ihre
            Ziele werden vereinigt. Mit dem Ignorieren-Filter pro Regel lassen sich einzelne Tickets
            (z. B. nach Label/Tag) gezielt ausnehmen. Trifft keine Regel zu, wird das Fallback-Ziel verwendet.
          </p>
          {editing && !editing.id && <RuleEditor rule={editing} config={config} targets={targets} mcpConnections={mcpConnections} onSaved={() => { setEditing(null); reloadRules(); }} onCancel={() => setEditing(null)} />}
          {rules.length === 0 && !editing && (
            <div className="empty" style={{ padding: "20px 0" }}><i className="bi bi-diagram-3"></i><div>Noch keine Regeln. Ohne Regel greift das Fallback-Ziel.</div></div>
          )}
          {rules.map((r) => (
            editing && editing.id === r.id ? (
              <RuleEditor key={r.id} rule={r} config={config} targets={targets} mcpConnections={mcpConnections} onSaved={() => { setEditing(null); reloadRules(); }} onCancel={() => setEditing(null)} />
            ) : (
              <div key={r.id} style={{ padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{r.name}</span>
                  {!r.enabled && <span className="tk-id" style={{ fontSize: 10 }}>inaktiv</span>}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                    {canEdit && <button className="btn-ghost" style={{ padding: "5px 9px" }} onClick={() => setEditing(r)}><i className="bi bi-pencil"></i></button>}
                    {canEdit && <button className="btn-ghost" style={{ padding: "5px 9px", color: "var(--err)" }} onClick={() => remove(r.id)}><i className="bi bi-trash"></i></button>}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
                  {(r.conditions || []).map((c, i) => (
                    <span key={i} className="mono" style={{ marginRight: 8 }}>
                      {LOGICAL_FIELD_LABELS[c.field] || c.field} {OPERATOR_LABELS[c.operator] || c.operator} {c.operator !== "exists" ? `"${c.value}"` : ""}
                    </span>
                  ))}
                </div>
                {(r.ignoreConditions || []).length > 0 && (
                  <div style={{ fontSize: 12, color: "var(--err)", marginTop: 4 }}>
                    <i className="bi bi-slash-circle" style={{ marginRight: 4 }}></i>
                    {(r.ignoreConditions || []).map((c, i) => (
                      <span key={i} className="mono" style={{ marginRight: 8 }}>
                        {LOGICAL_FIELD_LABELS[c.field] || c.field} {OPERATOR_LABELS[c.operator] || c.operator} {c.operator !== "exists" ? `"${c.value}"` : ""}
                      </span>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>
                  → {(r.targetIds || []).map(targetName).join(", ") || "(kein Ziel)"}
                  {(r.mcpIds || []).length > 0 && <span style={{ color: "var(--brand)" }}> · MCP: {(r.mcpIds || []).map(mcpName).join(", ")}</span>}
                </div>
              </div>
            )
          ))}
        </div>
      </div>

      <div className="card-x">
        <div className="card-head"><h6>Routing-Vorschau (Live-Test mit echtem Ticket)</h6></div>
        <div className="card-body-x">
          {preview && <Banner kind={preview.kind}>{preview.text}</Banner>}
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}><Field label="Ticket-Key" value={previewKey} onChange={setPreviewKey} placeholder="z. B. KAN-12" /></div>
            <button className="btn-primary-x" style={{ marginBottom: 12 }} disabled={!previewKey.trim()} onClick={runPreview}><i className="bi bi-search"></i>Vorschau</button>
          </div>
        </div>
      </div>
    </>
  );
}

// ============================================================
// Tab: Markdown-Vorlage
// ============================================================
function AdminMarkdown({ config, reloadConfig }) {
  const { canEdit } = React.useContext(AdminCtx);
  const [opts, setOpts] = React.useState(config.markdownOptions || {});
  const [msg, setMsg] = React.useState(null);
  const set = (k, v) => setOpts((o) => ({ ...o, [k]: v }));

  const save = async () => {
    setMsg(null);
    try {
      await adminApi("PUT", "/config/markdown", opts);
      setMsg({ kind: "ok", text: "Markdown-Vorlage gespeichert." });
      reloadConfig();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  return (
    <div className="card-x">
      <div className="card-head"><h6>Markdown-Vorlage</h6></div>
      <div className="card-body-x">
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>Überschriften der Abschnitte. Kommentare werden grundsätzlich ignoriert.</p>
        <Field label="Überschrift Beschreibung" value={opts.descriptionHeading} onChange={(v) => set("descriptionHeading", v)} />
        <Field label="Überschrift Lösung" value={opts.solutionHeading} onChange={(v) => set("solutionHeading", v)} />
        <Field label="Überschrift Hinweis" value={opts.hintHeading} onChange={(v) => set("hintHeading", v)} />
        <Field label="Überschrift Metadaten" value={opts.metadataHeading} onChange={(v) => set("metadataHeading", v)} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={opts.includeHint !== false} onChange={(e) => set("includeHint", e.target.checked)} /> Hinweis-Abschnitt einfügen (wenn vorhanden)
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={opts.includeMetadata !== false} onChange={(e) => set("includeMetadata", e.target.checked)} /> Metadaten (Kategorie/Stichwort) einfügen
        </label>
        <button className="btn-primary-x" onClick={save} disabled={!canEdit}><i className="bi bi-save"></i>Speichern</button>
      </div>
    </div>
  );
}

// ============================================================
// Tab: Sicherheit (Passwort ändern)
// ============================================================
function AdminSecurity() {
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [msg, setMsg] = React.useState(null);

  const save = async () => {
    setMsg(null);
    try {
      await adminApi("POST", "/password", { current, next });
      setCurrent("");
      setNext("");
      setMsg({ kind: "ok", text: "Passwort geändert." });
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  return (
    <div className="card-x" style={{ maxWidth: 420 }}>
      <div className="card-head"><h6>Admin-Passwort ändern</h6></div>
      <div className="card-body-x">
        {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
        <Field label="Aktuelles Passwort" type="password" value={current} onChange={setCurrent} />
        <Field label="Neues Passwort (min. 6 Zeichen)" type="password" value={next} onChange={setNext} />
        <button className="btn-primary-x" disabled={!current || !next} onClick={save}><i className="bi bi-key"></i>Ändern</button>
      </div>
    </div>
  );
}

// ============================================================
// Tab: MCP-Verbindungen
// ============================================================
function McpConnectionRow({ conn, onSaved }) {
  const { canEdit, isAdmin } = React.useContext(AdminCtx);
  const [title, setTitle] = React.useState(conn.title || "");
  const [description, setDescription] = React.useState(conn.description || "");
  const [msg, setMsg] = React.useState(null);
  const [requireAuth, setRequireAuth] = React.useState(Boolean(conn.requireAuth));
  const [token, setToken] = React.useState(conn.token || "");
  const [hasToken, setHasToken] = React.useState(Boolean(conn.hasToken));
  const [showToken, setShowToken] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [authBusy, setAuthBusy] = React.useState(false);
  const [allowFeedback, setAllowFeedback] = React.useState(Boolean(conn.allowFeedback));
  const [feedbackBusy, setFeedbackBusy] = React.useState(false);

  const save = async () => {
    setMsg(null);
    try {
      await adminApi("PUT", "/mcp-connections/" + encodeURIComponent(conn.id), { title, description });
      setMsg({ kind: "ok", text: "Gespeichert." });
      if (onSaved) onSaved();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  const toggleAuth = async (enabled) => {
    setAuthBusy(true);
    setMsg(null);
    try {
      const r = await adminApi("PUT", "/mcp-connections/" + encodeURIComponent(conn.id) + "/auth", { enabled });
      setRequireAuth(r.requireAuth);
      setHasToken(r.hasToken);
      if (r.token) setToken(r.token);
      if (enabled && r.token) setShowToken(true);
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    } finally {
      setAuthBusy(false);
    }
  };

  const regenerate = async () => {
    if (!window.confirm("Neues Token erzeugen? Bestehende Clients müssen das neue Token eintragen.")) return;
    setAuthBusy(true);
    setMsg(null);
    try {
      const r = await adminApi("POST", "/mcp-connections/" + encodeURIComponent(conn.id) + "/token", {});
      setToken(r.token);
      setHasToken(true);
      setShowToken(true);
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    } finally {
      setAuthBusy(false);
    }
  };

  const toggleFeedback = async (enabled) => {
    setFeedbackBusy(true);
    setMsg(null);
    try {
      const r = await adminApi("PUT", "/mcp-connections/" + encodeURIComponent(conn.id) + "/feedback", { enabled });
      setAllowFeedback(r.allowFeedback);
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    } finally {
      setFeedbackBusy(false);
    }
  };

  const copyToken = () => {
    try {
      navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (_err) { /* clipboard unavailable */ }
  };

  return (
    <div style={{ padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 8, marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span className="tk-id" style={{ fontSize: 11 }}>{conn.id}</span>
        {conn.isAll && <span className="tk-status-pill rework" style={{ fontSize: 10, padding: "2px 7px" }}><span className="dot"></span>Gesamtes Wissen</span>}
        {requireAuth
          ? <span className="tk-status-pill done" style={{ fontSize: 10, padding: "2px 7px" }}><span className="dot"></span>Auth aktiv</span>
          : <span className="tk-id" style={{ fontSize: 10 }}>öffentlich</span>}
      </div>
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      <Field label="Titel" value={title} onChange={setTitle} placeholder="Anzeigename" disabled={!canEdit} />
      <div className="k" style={{ marginBottom: 6 }}>Beschreibung</div>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Optionale Beschreibung"
        disabled={!canEdit}
        style={{ width: "100%", minHeight: 56, padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13, marginBottom: 10, fontFamily: "inherit", opacity: canEdit ? 1 : 0.6 }}
      />
      {canEdit && <button className="btn-primary-x" onClick={save}><i className="bi bi-save"></i>Speichern</button>}

      {isAdmin && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", marginBottom: requireAuth ? 10 : 0 }}>
            <input type="checkbox" checked={requireAuth} disabled={authBusy} onChange={(e) => toggleAuth(e.target.checked)} />
            <span><i className="bi bi-shield-lock" style={{ marginRight: 5 }}></i>Authentifizierung erforderlich (Bearer-Token)</span>
          </label>
          {requireAuth && (
            <>
              <p style={{ fontSize: 11.5, color: "var(--muted)", margin: "0 0 8px" }}>
                Clients (z. B. Claude) müssen das Token als <code>Authorization: Bearer &lt;token&gt;</code> senden.
              </p>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ flex: 1, fontSize: 12, padding: "8px 10px", background: "var(--brand-tint)", borderRadius: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {hasToken ? (showToken ? (token || "(verborgen)") : "••••••••••••••••") : "(kein Token)"}
                </span>
                <button className="btn-ghost" style={{ padding: "7px 10px" }} onClick={() => setShowToken((s) => !s)} title={showToken ? "Verbergen" : "Anzeigen"}>
                  <i className={"bi " + (showToken ? "bi-eye-slash" : "bi-eye")}></i>
                </button>
                <button className="btn-ghost" style={{ padding: "7px 10px" }} onClick={copyToken} disabled={!token} title="Kopieren">
                  <i className={"bi " + (copied ? "bi-check-lg" : "bi-clipboard")}></i>
                </button>
                <button className="btn-ghost" style={{ padding: "7px 10px" }} onClick={regenerate} disabled={authBusy} title="Neu erzeugen">
                  <i className="bi bi-arrow-repeat"></i>
                </button>
              </div>
            </>
          )}
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", marginTop: 12 }}>
            <input type="checkbox" checked={allowFeedback} disabled={feedbackBusy} onChange={(e) => toggleFeedback(e.target.checked)} />
            <span><i className="bi bi-chat-left-dots" style={{ marginRight: 5 }}></i>Fehler-Rückmeldung erlauben (Kommentar + Verschieben)</span>
          </label>
          {allowFeedback && (
            <p style={{ fontSize: 11.5, color: "var(--muted)", margin: "8px 0 0" }}>
              Stellt das Werkzeug <code>report_inaccuracy</code> bereit: Clients können eine gemeldete Ungenauigkeit
              als Jira-Kommentar zurückschreiben. Ist ein „Wird überarbeitet"-Status konfiguriert, wird das Ticket
              zusätzlich dorthin verschoben.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function AdminMcp({ mcpConnections, reloadMcp }) {
  return (
    <div className="card-x">
      <div className="card-head"><h6>MCP-Verbindungen</h6></div>
      <div className="card-body-x">
        <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
          Sechs feste MCP-Verbindungen stellen Ticket-Wissen über das Model Context Protocol bereit.
          Die IDs (Slugs) sind unveränderlich; Titel und Beschreibung sind frei wählbar. Die Zuordnung
          von Tickets zu den Verbindungen 1-5 erfolgt über Routing-Regeln. Die Verbindung „All-in-One"
          enthält das Wissen aller aktiven Tickets. Pro Verbindung kann eine Bearer-Token-Authentifizierung
          aktiviert werden, damit nicht jeder mit der URL das Wissen abrufen kann.
        </p>
        {(mcpConnections || []).map((c) => (
          <McpConnectionRow key={c.id} conn={c} onSaved={reloadMcp} />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Tab: Zugriff & Nutzer (Sperre, Benutzer-Login, Rechte)
// ============================================================
function AdminAccess() {
  const [cfg, setCfg] = React.useState(null);
  const [msg, setMsg] = React.useState(null);
  const [userPw, setUserPw] = React.useState("");
  const [savingPerms, setSavingPerms] = React.useState(false);

  const load = React.useCallback(() => {
    return adminApi("GET", "/access-config")
      .then(setCfg)
      .catch((e) => setMsg({ kind: "err", text: e.message }));
  }, []);
  React.useEffect(() => { load(); }, [load]);

  const patch = async (body, okText) => {
    setMsg(null);
    try {
      const r = await adminApi("PUT", "/access-config", body);
      setCfg((c) => ({ ...c, ...r }));
      if (okText) setMsg({ kind: "ok", text: okText });
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  const setPerm = (key, value) => {
    const next = { ...cfg.userPermissions, [key]: value };
    setSavingPerms(true);
    patch({ userPermissions: next }, null).finally(() => setSavingPerms(false));
  };

  const saveUserPw = async (clear) => {
    setMsg(null);
    try {
      const r = await adminApi("PUT", "/user-password", clear ? { clear: true } : { password: userPw });
      setUserPw("");
      setCfg((c) => ({ ...c, userLoginEnabled: r.userLoginEnabled }));
      setMsg({ kind: "ok", text: clear ? "Benutzer-Login entfernt." : "Benutzer-Passwort gesetzt." });
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  if (!cfg) return <div className="empty"><i className="bi bi-hourglass"></i><div>Lade...</div></div>;
  const perms = cfg.userPermissions || {};

  const permRow = (key, label, hint, disabled) => (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0", borderTop: "1px solid var(--border)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 }}>
      <input type="checkbox" style={{ marginTop: 3 }} checked={Boolean(perms[key])} disabled={disabled || savingPerms} onChange={(e) => setPerm(key, e.target.checked)} />
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{hint}</div>
      </div>
    </label>
  );

  return (
    <>
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

      <div className="card-x" style={{ marginBottom: 16 }}>
        <div className="card-head"><h6>Dashboard-Sperre</h6></div>
        <div className="card-body-x">
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
            Ist die Sperre aktiv, sind das gesamte Dashboard und die Live-Daten nur nach Anmeldung
            (Admin oder Benutzer) sichtbar. So kann nicht jeder einsehen, welche Daten fließen.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className={"tk-status-pill " + (cfg.dashboardLocked ? "done" : "rework")} style={{ fontSize: 11 }}>
              <span className="dot"></span>{cfg.dashboardLocked ? "Gesperrt" : "Öffentlich"}
            </span>
            <button
              className={cfg.dashboardLocked ? "btn-ghost" : "btn-primary-x"}
              onClick={() => patch({ dashboardLocked: !cfg.dashboardLocked }, cfg.dashboardLocked ? "Sperre deaktiviert." : "Dashboard gesperrt.")}
            >
              <i className={"bi " + (cfg.dashboardLocked ? "bi-unlock" : "bi-lock")}></i>
              {cfg.dashboardLocked ? "Sperre aufheben" : "Dashboard sperren"}
            </button>
          </div>
        </div>
      </div>

      <div className="card-x" style={{ marginBottom: 16 }}>
        <div className="card-head"><h6>Benutzer-Login</h6></div>
        <div className="card-body-x">
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
            Neben dem Admin kann ein separates Benutzer-Passwort vergeben werden. Benutzer sehen das
            Dashboard und – je nach den unten gesetzten Rechten – ausgewählte Einstellungen.
            {" "}Aktueller Status: <b>{cfg.userLoginEnabled ? "aktiv" : "deaktiviert"}</b>.
          </p>
          <Field
            label={"Benutzer-Passwort (min. 6 Zeichen)" + (cfg.userLoginEnabled ? " (gesetzt — neues Passwort überschreibt)" : "")}
            type="password"
            value={userPw}
            onChange={setUserPw}
            placeholder={cfg.userLoginEnabled ? "•••••••• gesetzt" : "Benutzer-Passwort"}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-primary-x" disabled={!userPw} onClick={() => saveUserPw(false)}>
              <i className="bi bi-key"></i>Passwort setzen
            </button>
            {cfg.userLoginEnabled && (
              <button className="btn-danger-x" onClick={() => saveUserPw(true)}>
                <i className="bi bi-person-x"></i>Benutzer-Login entfernen
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card-x">
        <div className="card-head"><h6>Benutzer-Rechte</h6></div>
        <div className="card-body-x">
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
            Legt fest, was angemeldete <b>Benutzer</b> (nicht Admins) dürfen. Admins haben stets alle Rechte.
          </p>
          {permRow("viewSettings", "Einstellungen einsehen", "Darf den Einstellungen-Tab öffnen und die Konfiguration lesen.", false)}
          {permRow("editSettings", "Einstellungen bearbeiten", "Darf die Konfiguration ändern (impliziert „einsehen“).", false)}
          {permRow("manageLifecycle", "Ticket-Lebenszyklus verwalten", "Darf Tickets als veraltet markieren, löschen und reaktivieren.", false)}
        </div>
      </div>
    </>
  );
}

// ============================================================
// Tab: Updates (Versionsbanner & Update-Check)
// ============================================================
function AdminUpdates() {
  const [cfg, setCfg] = React.useState(null);
  const [status, setStatus] = React.useState(null);
  const [msg, setMsg] = React.useState(null);

  // Formularfelder Einstellungen.
  const [enabled, setEnabled] = React.useState(true);
  const [repo, setRepo] = React.useState("");
  const [webhookSecret, setWebhookSecret] = React.useState("");
  const [githubToken, setGithubToken] = React.useState("");
  const [githubTokenExpiresAt, setGithubTokenExpiresAt] = React.useState("");
  const [clearToken, setClearToken] = React.useState(false);
  const [savingCfg, setSavingCfg] = React.useState(false);
  const [checking, setChecking] = React.useState(false);

  // Formularfelder Ankündigung.
  const [annLevel, setAnnLevel] = React.useState("release");
  const [annVersion, setAnnVersion] = React.useState("");
  const [annTitle, setAnnTitle] = React.useState("");
  const [annBody, setAnnBody] = React.useState("");
  const [publishing, setPublishing] = React.useState(false);

  const loadCfg = React.useCallback(() => {
    return adminApi("GET", "/version/config")
      .then((d) => {
        setCfg(d);
        setEnabled(d.enabled);
        setRepo(d.repo || "");
        setGithubTokenExpiresAt(d.githubTokenExpiresAt || "");
      })
      .catch((e) => setMsg({ kind: "err", text: e.message }));
  }, []);

  // Der öffentliche Status liegt unter /api/version (nicht /api/admin).
  const loadStatus = React.useCallback(() => {
    return fetch("/api/version")
      .then((r) => r.json())
      .then((d) => setStatus(d))
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    loadCfg();
    loadStatus();
  }, [loadCfg, loadStatus]);

  const checkNow = async () => {
    setChecking(true);
    setMsg(null);
    try {
      const res = await adminApi("POST", "/version/check", {});
      setStatus(res);
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    } finally {
      setChecking(false);
    }
  };

  const saveCfg = async () => {
    setSavingCfg(true);
    setMsg(null);
    try {
      const body = { enabled, repo, githubTokenExpiresAt };
      if (webhookSecret) body.githubWebhookSecret = webhookSecret;
      // Neues Token überschreibt das gespeicherte; null entfernt es explizit.
      if (githubToken) body.githubToken = githubToken;
      else if (clearToken) body.githubToken = null;
      await adminApi("PUT", "/version/config", body);
      setWebhookSecret("");
      setGithubToken("");
      setClearToken(false);
      setMsg({ kind: "ok", text: "Einstellungen gespeichert." });
      await loadCfg();
      await loadStatus();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    } finally {
      setSavingCfg(false);
    }
  };

  const publish = async () => {
    setPublishing(true);
    setMsg(null);
    try {
      await adminApi("POST", "/version/announce", {
        level: annLevel,
        version: annVersion,
        title: annTitle,
        body: annBody,
      });
      setAnnVersion("");
      setAnnTitle("");
      setAnnBody("");
      setMsg({ kind: "ok", text: "Ankündigung veröffentlicht." });
      await loadStatus();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    } finally {
      setPublishing(false);
    }
  };

  const removeAnnouncement = async (id) => {
    if (!window.confirm("Diese Ankündigung wirklich löschen?")) return;
    try {
      await adminApi("DELETE", "/version/announcements/" + encodeURIComponent(id));
      await loadStatus();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    }
  };

  const current = status ? status.currentVersion : "—";
  const latest = status && status.latestVersion ? status.latestVersion : "—";
  const lastChecked = status && status.lastCheckedAt
    ? new Date(status.lastCheckedAt).toLocaleString("de-DE")
    : "noch nie";
  const announcements = (status && status.announcements) || [];

  return (
    <>
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

      <div className="card-x">
        <div className="card-head"><h6>Version & Update-Check</h6></div>
        <div className="card-body-x">
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
            <div>
              <div className="k" style={{ marginBottom: 4 }}>Installierte Version</div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{current}</div>
            </div>
            <div>
              <div className="k" style={{ marginBottom: 4 }}>Neueste Version</div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{latest}</div>
            </div>
            <div>
              <div className="k" style={{ marginBottom: 4 }}>Status</div>
              {status && status.updateAvailable ? (
                <span className="tk-status-pill rework" style={{ fontSize: 11 }}>
                  <span className="dot"></span>Update verfügbar: {status.latestVersion}
                </span>
              ) : (
                <span className="tk-status-pill done" style={{ fontSize: 11 }}>
                  <span className="dot"></span>Aktuell
                </span>
              )}
            </div>
            <div style={{ marginLeft: "auto" }}>
              <button className="btn-ghost" onClick={checkNow} disabled={checking}>
                <i className="bi bi-arrow-repeat"></i>{checking ? "Prüfe..." : "Jetzt prüfen"}
              </button>
            </div>
          </div>

          {status && status.lastError && (
            <Banner kind="err">{status.lastError}</Banner>
          )}

          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 16 }}>
            Zuletzt geprüft: {lastChecked}
          </div>

          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12, cursor: "pointer" }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Update-Check aktiviert
            </label>

            <Field
              label="GitHub-Repository (owner/repo)"
              value={repo}
              onChange={setRepo}
              placeholder="Mori-Takahashi/KnowFlow"
            />
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: -6, marginBottom: 12 }}>
              Forks tragen hier ihr eigenes Repository ein, um eigene Releases zu verfolgen.
            </div>

            <Field
              label={
                "GitHub-Token (für private Repositories)" +
                (cfg && cfg.hasGithubToken ? " (gesetzt — leer lassen, um beizubehalten)" : "")
              }
              type="password"
              value={githubToken}
              onChange={setGithubToken}
              placeholder={cfg && cfg.hasGithubToken ? "•••••••• (gesetzt)" : "Optional, z. B. github_pat_…"}
            />
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: -6, marginBottom: 12 }}>
              Ohne Token antwortet GitHub bei privaten Repositories mit 404. Ein Fine-grained
              Personal Access Token mit Lesezugriff auf „Contents" des Repos genügt.
              {cfg && cfg.hasGithubToken && (
                <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, cursor: "pointer" }}>
                  <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} />
                  Gespeichertes Token beim Speichern entfernen
                </label>
              )}
            </div>

            <Field
              label="Ablaufdatum des GitHub-Tokens (optional)"
              type="date"
              value={githubTokenExpiresAt}
              onChange={setGithubTokenExpiresAt}
            />
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: -6, marginBottom: 12 }}>
              10 Tage vor Ablauf erscheint eine Warnung im Dashboard. Leer lassen, um die Erinnerung zu deaktivieren.
            </div>

            <Field
              label={
                "GitHub-Webhook-Secret" +
                (cfg && cfg.hasWebhookSecret ? " (gesetzt — leer lassen, um beizubehalten)" : "")
              }
              type="password"
              value={webhookSecret}
              onChange={setWebhookSecret}
              placeholder={cfg && cfg.hasWebhookSecret ? "•••••••• (gesetzt)" : "Optionales Secret"}
            />

            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
              Webhook-URL: <code>&lt;Base-URL&gt;/webhook/github</code> (Events: release, push).
              Alternativ prüft der Bot alle 6 Stunden automatisch die GitHub-Releases.
            </div>

            <button className="btn-primary-x" onClick={saveCfg} disabled={savingCfg}>
              <i className="bi bi-save"></i>{savingCfg ? "Speichere..." : "Speichern"}
            </button>
          </div>
        </div>
      </div>

      <div className="card-x" style={{ marginTop: 16 }}>
        <div className="card-head"><h6>Manuelle Ankündigung</h6></div>
        <div className="card-body-x">
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
            Für Forks oder eigene Versionen ohne GitHub-Releases: Verteile eine Ankündigung
            direkt an alle Dashboards. Ein Banner (Release) bleibt sichtbar, bis Nutzer ihn
            wegklicken; ein Toast (kleine Änderung) wird kurz eingeblendet.
          </p>

          <div className="filter-chips" style={{ marginBottom: 12 }}>
            <button
              className={"chip " + (annLevel === "release" ? "active" : "")}
              onClick={() => setAnnLevel("release")}
            >
              <i className="bi bi-megaphone" style={{ marginRight: 5 }}></i>Banner (Release)
            </button>
            <button
              className={"chip " + (annLevel === "patch" ? "active" : "")}
              onClick={() => setAnnLevel("patch")}
            >
              <i className="bi bi-chat-dots" style={{ marginRight: 5 }}></i>Toast (kleine Änderung)
            </button>
          </div>

          <Field label="Version (optional)" value={annVersion} onChange={setAnnVersion} placeholder="z. B. 1.4.0" />
          <Field label="Titel" value={annTitle} onChange={setAnnTitle} placeholder="Kurzer Titel der Ankündigung" />
          <div className="k" style={{ marginBottom: 6 }}>Beschreibung</div>
          <textarea
            value={annBody}
            onChange={(e) => setAnnBody(e.target.value)}
            placeholder="Optionale Beschreibung"
            style={{ width: "100%", minHeight: 72, padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13, marginBottom: 12, fontFamily: "inherit" }}
          />
          <button className="btn-primary-x" onClick={publish} disabled={publishing || !annTitle.trim()}>
            <i className="bi bi-send"></i>{publishing ? "Veröffentliche..." : "Veröffentlichen"}
          </button>

          {announcements.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div className="k" style={{ marginBottom: 8 }}>Vorhandene Ankündigungen</div>
              {announcements.map((a) => (
                <div
                  key={a.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    marginBottom: 8,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: 13 }}>{a.title}</strong>
                      <span
                        className={"tk-status-pill " + (a.level === "release" ? "rework" : "done")}
                        style={{ fontSize: 10, padding: "2px 7px" }}
                      >
                        <span className="dot"></span>{a.level === "release" ? "Banner" : "Toast"}
                      </span>
                      {a.version && <span className="tk-id" style={{ fontSize: 11 }}>v{a.version}</span>}
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>
                        {a.createdAt ? new Date(a.createdAt).toLocaleString("de-DE") : ""}
                      </span>
                    </div>
                  </div>
                  <button className="btn-danger-x" onClick={() => removeAnnouncement(a.id)}>
                    <i className="bi bi-trash3"></i>Löschen
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ============================================================
// Tab: Danger Zone (destruktive Wartungsaktionen)
// ============================================================

// Eine Aktions-Zeile in der Danger-Zone-Karte. Klick auf den roten Button
// öffnet inline einen Bestätigungsbereich mit Passwort-Feld; es ist immer nur
// eine Aktion gleichzeitig offen (gesteuert über open/onOpen/onCancel der Elternkomponente).
function DangerAction({ title, description, buttonLabel, icon, open, onOpen, onCancel, onConfirm, busy }) {
  const [password, setPassword] = React.useState("");

  const cancel = () => {
    setPassword("");
    onCancel();
  };

  const confirm = async () => {
    await onConfirm(password);
    setPassword("");
  };

  return (
    <div style={{ borderTop: "1px solid #fee2e2", padding: "14px 0" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{title}</div>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 3 }}>{description}</div>
        </div>
        <button className="btn-danger-x" disabled={busy} onClick={onOpen} style={{ flexShrink: 0 }}>
          <i className={"bi " + icon}></i>{buttonLabel}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 12, padding: "12px 14px", background: "var(--err-tint)", border: "1px solid #fecaca", borderRadius: 8 }}>
          <div style={{ fontSize: 12.5, color: "#991b1b", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <i className="bi bi-exclamation-triangle-fill"></i>
            <span>Diese Aktion kann nicht rückgängig gemacht werden. Bitte mit dem Admin-Passwort bestätigen.</span>
          </div>
          <Field label="Admin-Passwort zur Bestätigung" type="password" value={password} onChange={setPassword} placeholder="Admin-Passwort" />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-danger-x" disabled={busy || !password} onClick={confirm}>
              <i className="bi bi-trash3"></i>{busy ? "Wird ausgeführt..." : "Endgültig ausführen"}
            </button>
            <button className="btn-ghost" disabled={busy} onClick={cancel}>Abbrechen</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AdminDangerZone({ reloadConfig, reloadTargets, reloadRules }) {
  const [status, setStatus] = React.useState(null);
  const [statusError, setStatusError] = React.useState(null);
  const [openAction, setOpenAction] = React.useState(null); // id der offenen Aktion
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null); // { kind, text }
  const [toggleBusy, setToggleBusy] = React.useState(false);

  const reloadStatus = React.useCallback(() => {
    return adminApi("GET", "/danger/status")
      .then((d) => { setStatus(d); setStatusError(null); })
      .catch((e) => setStatusError(e.message));
  }, []);

  React.useEffect(() => { reloadStatus(); }, [reloadStatus]);

  const ingestEnabled = status ? status.webhookIngestEnabled : true;
  const ticketCount = status ? status.counts.tickets : 0;
  const eventCount = status ? status.counts.events : 0;

  const toggleIngest = async () => {
    setToggleBusy(true);
    setMsg(null);
    try {
      await adminApi("PUT", "/danger/webhook-ingest", { enabled: !ingestEnabled });
      await reloadStatus();
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    } finally {
      setToggleBusy(false);
    }
  };

  // Führt eine destruktive Aktion aus: ruft den Endpunkt mit Passwort auf,
  // zeigt das Ergebnis als Banner, schließt den Bestätigungsbereich und lädt
  // den Status (und ggf. weitere Bereiche) neu.
  const runAction = async (id, path, password, buildSuccess, reloads) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await adminApi("POST", path, { password });
      setMsg({ kind: "ok", text: buildSuccess(res) });
      setOpenAction(null);
      await reloadStatus();
      (reloads || []).forEach((fn) => { if (fn) fn(); });
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const shutdown = async (password) => {
    setBusy(true);
    setMsg(null);
    try {
      await adminApi("POST", "/danger/shutdown", { password });
      setOpenAction(null);
      setMsg({ kind: "info", text: "Dienst wird beendet — die Seite ist gleich kurz nicht erreichbar." });
    } catch (err) {
      setMsg({ kind: "err", text: err.message });
    } finally {
      setBusy(false);
    }
  };

  const actionProps = (id) => ({
    open: openAction === id,
    onOpen: () => { setOpenAction(id); setMsg(null); },
    onCancel: () => setOpenAction(null),
    busy,
  });

  if (statusError) {
    return (
      <div className="card-x">
        <div className="card-head"><h6>Danger Zone</h6></div>
        <div className="card-body-x">
          <Banner kind="err">Status konnte nicht geladen werden: {statusError}</Banner>
        </div>
      </div>
    );
  }

  return (
    <>
      <Banner kind="info">
        Aktionen in diesem Bereich sind destruktiv und können — bis auf die Webhook-Pause — nicht rückgängig gemacht werden.
      </Banner>

      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

      <div className="card-x" style={{ marginBottom: 16 }}>
        <div className="card-head"><h6>Webhook-Verarbeitung</h6></div>
        <div className="card-body-x">
          <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 0 }}>
            Pausiert die Verarbeitung eingehender Jira-Webhooks. Im pausierten Zustand werden Webhooks
            mit „202 ignoriert" beantwortet und nicht verarbeitet. Reversibel und ohne Passwort.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className={"tk-status-pill " + (ingestEnabled ? "done" : "rework")} style={{ fontSize: 11 }}>
              <span className="dot"></span>{ingestEnabled ? "Aktiv" : "Pausiert"}
            </span>
            {ingestEnabled ? (
              <button className="btn-danger-x" disabled={toggleBusy} onClick={toggleIngest}>
                <i className="bi bi-pause-circle"></i>{toggleBusy ? "..." : "Verarbeitung pausieren"}
              </button>
            ) : (
              <button className="btn-primary-x" disabled={toggleBusy} onClick={toggleIngest}>
                <i className="bi bi-play-circle"></i>{toggleBusy ? "..." : "Verarbeitung aktivieren"}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card-x" style={{ border: "1px solid #fecaca" }}>
        <div className="card-head" style={{ borderBottom: "1px solid #fee2e2" }}>
          <h6 style={{ color: "#b91c1c" }}><i className="bi bi-exclamation-triangle" style={{ marginRight: 6 }}></i>Danger Zone</h6>
        </div>
        <div className="card-body-x" style={{ paddingTop: 0 }}>
          <DangerAction
            {...actionProps("clear-events")}
            title="Aktivitäts-Feed leeren"
            description={"Löscht alle Einträge im Aktivitäts-Feed (" + eventCount + " Einträge im Feed). Tickets und Wissen bleiben erhalten."}
            buttonLabel="Feed leeren"
            icon="bi-list-ul"
            onConfirm={(pw) => runAction("clear-events", "/danger/clear-events", pw, (r) => r.deleted + " Einträge gelöscht.", [])}
          />
          <DangerAction
            {...actionProps("wipe-tickets")}
            title="Alle Tickets & Wissen löschen"
            description={"Entfernt alle Tickets, das hochgeladene Wissen aus den Wissensbasen und die lokalen Anhänge (" + ticketCount + " Tickets in der Datenbank)."}
            buttonLabel="Tickets löschen"
            icon="bi-trash3"
            onConfirm={(pw) => runAction("wipe-tickets", "/danger/wipe-tickets", pw, (r) => r.deleted + " Ticket(s) und zugehöriges Wissen gelöscht.", [reloadConfig, reloadTargets, reloadRules])}
          />
          <DangerAction
            {...actionProps("reset-config")}
            title="Konfiguration zurücksetzen"
            description="Setzt Jira-Verbindung, Wissensbasen, Routing-Regeln, Feld-Zuordnung und Markdown-Vorlage auf den Auslieferungszustand. Das Admin-Passwort bleibt erhalten."
            buttonLabel="Zurücksetzen"
            icon="bi-arrow-counterclockwise"
            onConfirm={(pw) => runAction("reset-config", "/danger/reset-config", pw, () => "Konfiguration auf den Auslieferungszustand zurückgesetzt.", [reloadConfig, reloadTargets, reloadRules])}
          />
          <DangerAction
            {...actionProps("shutdown")}
            title="Dienst beenden / neu starten"
            description="Beendet den Prozess. Unter Docker (restart: unless-stopped) startet der Dienst automatisch neu."
            buttonLabel="Dienst beenden"
            icon="bi-power"
            onConfirm={shutdown}
          />
        </div>
      </div>
    </>
  );
}

// ============================================================
// Admin-Panel (Tabs + Datenladen)
// ============================================================
function AdminPanel({ role, permissions, onLogout }) {
  const isAdmin = role === "admin";
  const perms = permissions || {};
  const canView = isAdmin || perms.viewSettings;
  const canEdit = isAdmin || perms.editSettings;
  const [tab, setTab] = React.useState("general");
  const [config, setConfig] = React.useState(null);
  const [targets, setTargets] = React.useState([]);
  const [rules, setRules] = React.useState([]);
  const [fields, setFields] = React.useState([]);
  const [mcpConnections, setMcpConnections] = React.useState([]);
  const [fieldsError, setFieldsError] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);

  const reloadConfig = React.useCallback(() => adminApi("GET", "/config").then(setConfig).catch((e) => setLoadError(e.message)), []);
  const reloadTargets = React.useCallback(() => adminApi("GET", "/targets").then((d) => setTargets(d.targets)).catch(() => {}), []);
  const reloadRules = React.useCallback(() => adminApi("GET", "/rules").then((d) => setRules(d.rules)).catch(() => {}), []);
  const reloadFields = React.useCallback(() => adminApi("GET", "/jira/fields").then((d) => { setFields(d.fields); setFieldsError(null); }).catch((e) => setFieldsError(e.message)), []);
  const reloadMcp = React.useCallback(() => adminApi("GET", "/mcp-connections").then((d) => setMcpConnections(d.connections)).catch(() => {}), []);

  React.useEffect(() => {
    if (!canView) return;
    reloadConfig();
    reloadTargets();
    reloadRules();
    reloadFields();
    reloadMcp();
  }, [canView, reloadConfig, reloadTargets, reloadRules, reloadFields, reloadMcp]);

  const logout = async () => {
    try { await adminApi("POST", "/logout", {}); } catch (_e) {}
    onLogout();
  };

  // Config tabs are available to admins and to users with view rights; the
  // remaining tabs are admin-only.
  const tabs = [];
  if (canView) {
    tabs.push(
      { id: "general", label: "Allgemein", icon: "bi-sliders" },
      { id: "fields", label: "Feld-Zuordnung", icon: "bi-input-cursor-text" },
      { id: "targets", label: "Wissensbasen", icon: "bi-hdd-stack" },
      { id: "routing", label: "Routing-Regeln", icon: "bi-diagram-3" },
      { id: "mcp", label: "MCP-Verbindungen", icon: "bi-hdd-network" },
      { id: "rag", label: "RAG", icon: "bi-stars" },
      { id: "quickchat", label: "Schneller Chat", icon: "bi-chat-dots" },
      { id: "markdown", label: "Markdown", icon: "bi-markdown" },
    );
  }
  if (isAdmin) {
    tabs.push(
      { id: "updates", label: "Updates", icon: "bi-arrow-repeat" },
      { id: "access", label: "Zugriff & Nutzer", icon: "bi-people" },
      { id: "security", label: "Sicherheit", icon: "bi-shield-lock" },
      { id: "danger", label: "Danger Zone", icon: "bi-exclamation-triangle" },
    );
  }

  // A user without any settings rights still reaches this panel (e.g. only
  // lifecycle rights); show a friendly note instead of an empty shell.
  if (!isAdmin && !canView) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title"><i className="bi bi-person-badge" style={{ marginRight: 8 }}></i>Benutzerkonto</h1>
            <p className="page-sub">Du bist als Benutzer angemeldet.</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn-ghost" onClick={logout}><i className="bi bi-box-arrow-right"></i>Abmelden</button>
          </div>
        </div>
        <Banner kind="info">
          Für dieses Konto sind keine Einstellungs-Rechte freigeschaltet.
          {perms.manageLifecycle && " Du kannst den Lebenszyklus von Tickets im Tab „Tickets“ verwalten."}
        </Banner>
      </>
    );
  }

  // Ensure the selected tab is one the role may actually see.
  const activeTab = tabs.some((t) => t.id === tab) ? tab : (tabs[0] && tabs[0].id);

  if (loadError) {
    return (
      <>
        <div className="page-head"><div><h1 className="page-title">Einstellungen</h1></div></div>
        <Banner kind="err">Konfiguration konnte nicht geladen werden: {loadError}</Banner>
      </>
    );
  }
  if (!config) {
    return <div className="empty"><i className="bi bi-hourglass"></i><div>Lade Konfiguration...</div></div>;
  }

  return (
    <AdminCtx.Provider value={{ canEdit, isAdmin }}>
      <div className="page-head">
        <div>
          <h1 className="page-title"><i className="bi bi-gear" style={{ marginRight: 8 }}></i>{isAdmin ? "Admin-Dashboard" : "Einstellungen"}</h1>
          <p className="page-sub">{isAdmin ? "Alle Einstellungen für den KnowFlow · zur Laufzeit änderbar" : "Eingeschränkter Zugriff als Benutzer"}</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-ghost" onClick={logout}><i className="bi bi-box-arrow-right"></i>Abmelden</button>
        </div>
      </div>

      {canView && !canEdit && (
        <Banner kind="info">Nur-Lese-Zugriff: Du kannst die Konfiguration einsehen, aber nicht ändern.</Banner>
      )}

      <div className="tickets-toolbar">
        <div className="filter-chips">
          {tabs.map((t) => (
            <button key={t.id} className={"chip " + (activeTab === t.id ? "active" : "")} onClick={() => setTab(t.id)}>
              <i className={"bi " + t.icon} style={{ marginRight: 5 }}></i>{t.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "general" && <AdminGeneral config={config} reloadConfig={reloadConfig} />}
      {activeTab === "fields" && <AdminFieldMapping config={config} fields={fields} fieldsError={fieldsError} reloadConfig={reloadConfig} />}
      {activeTab === "targets" && <AdminTargets config={config} targets={targets} reloadTargets={reloadTargets} reloadConfig={reloadConfig} />}
      {activeTab === "routing" && <AdminRouting config={config} targets={targets} mcpConnections={mcpConnections} rules={rules} reloadRules={reloadRules} />}
      {activeTab === "mcp" && <AdminMcp mcpConnections={mcpConnections} reloadMcp={reloadMcp} />}
      {activeTab === "rag" && <AdminRag config={config} reloadConfig={reloadConfig} />}
      {activeTab === "quickchat" && <AdminQuickChat targets={targets} />}
      {activeTab === "markdown" && <AdminMarkdown config={config} reloadConfig={reloadConfig} />}
      {activeTab === "updates" && isAdmin && <AdminUpdates />}
      {activeTab === "access" && isAdmin && <AdminAccess />}
      {activeTab === "security" && isAdmin && <AdminSecurity />}
      {activeTab === "danger" && isAdmin && <AdminDangerZone reloadConfig={reloadConfig} reloadTargets={reloadTargets} reloadRules={reloadRules} />}
    </AdminCtx.Provider>
  );
}

// ============================================================
// Einstiegspunkt: prüft Session und zeigt Login oder Panel
// ============================================================
function Admin() {
  const [session, setSession] = React.useState(undefined); // undefined = unbekannt

  const check = React.useCallback(() => {
    return adminApi("GET", "/session")
      .then((d) => setSession(d))
      .catch(() => setSession({ authenticated: false }));
  }, []);

  React.useEffect(() => { check(); }, [check]);

  const onAuthChanged = () => {
    check();
    if (window.KNOWFLOW_RELOAD_ACCESS) window.KNOWFLOW_RELOAD_ACCESS();
  };

  if (session === undefined) {
    return <div className="empty"><i className="bi bi-hourglass"></i><div>Prüfe Sitzung...</div></div>;
  }
  if (!session.authenticated) {
    return <AdminLogin onSuccess={onAuthChanged} />;
  }
  return (
    <AdminPanel
      role={session.role}
      permissions={session.permissions}
      onLogout={onAuthChanged}
    />
  );
}

window.Admin = Admin;
