// ============================================================
// Schneller Chat (Quick Chat) · Beta
// Temporary, ephemeral chat that runs over the OpenWebUI API of the
// admin-selected knowledge base. History lives only in this component's state
// and is never persisted. The system prompt stays server-side.
//
// Two things make the answers traceable:
//   1. Quellen (sources): OpenWebUI's RAG stream reports which knowledge files
//      it retrieved. Each file is named "<JIRA-ID>.md", so we turn every source
//      into a clickable chip that links straight to the original Jira ticket.
//   2. Denkprozess (thinking): reasoning models emit their scratch-work either
//      as `<think>…</think>` inside the content or as a separate `reasoning`
//      delta. We split that out and show a live "denkt nach…" panel so the user
//      can follow which tickets the model is looking at while it works.
// ============================================================

// Pulls the reasoning ("<think>…</think>") out of a raw content string and
// returns the visible answer separately. `open` is true while a think block has
// been opened but not yet closed (i.e. the model is still reasoning).
function splitThinking(raw) {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let reasoning = "";
  let content = "";
  let rest = raw;
  let open = false;
  while (rest.length) {
    const i = rest.indexOf(OPEN);
    if (i === -1) { content += rest; break; }
    content += rest.slice(0, i);
    rest = rest.slice(i + OPEN.length);
    const j = rest.indexOf(CLOSE);
    if (j === -1) { reasoning += rest; open = true; break; }
    reasoning += rest.slice(0, j);
    rest = rest.slice(j + CLOSE.length);
  }
  return { reasoning: reasoning.trim(), content: content.trim(), open };
}

// Normalizes OpenWebUI's `sources` payload into a de-duplicated list of
// { id, label, url, snippet }. Source file names look like "PROJ-123.md"; when
// the id matches a Jira key and a base URL is known we build a /browse/ link.
function normalizeSources(rawSources, jiraBaseUrl) {
  if (!Array.isArray(rawSources)) return [];
  const base = (jiraBaseUrl || "").replace(/\/+$/, "");
  const out = [];
  const seen = new Set();
  for (const s of rawSources) {
    if (!s || typeof s !== "object") continue;
    const names = [];
    if (s.source && typeof s.source.name === "string") names.push(s.source.name);
    if (Array.isArray(s.metadata)) {
      for (const md of s.metadata) {
        if (md && typeof md.name === "string") names.push(md.name);
        if (md && typeof md.source === "string") names.push(md.source);
      }
    }
    let snippet = "";
    if (Array.isArray(s.document)) {
      snippet = s.document.filter((d) => typeof d === "string").join("\n").trim();
    }
    for (const rawName of names) {
      const id = String(rawName).split(/[\\/]/).pop().replace(/\.md$/i, "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const isJira = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(id);
      out.push({
        id,
        label: id,
        url: isJira && base ? `${base}/browse/${encodeURIComponent(id)}` : "",
        snippet: snippet.slice(0, 500),
      });
    }
  }
  return out;
}

// Collapsible panel that shows the model's reasoning. Auto-expands while the
// model is still thinking and lists the tickets it is currently consulting.
function ThinkingPanel({ reasoning, sources, live }) {
  // Auto-expand while the model is actively thinking (live feedback), then
  // collapse to a toggle once it is done so the answer stays prominent.
  const [open, setOpen] = React.useState(Boolean(live));
  React.useEffect(() => { setOpen(Boolean(live)); }, [live]);
  const tickets = (sources || []).map((s) => s.label);
  return (
    <div className={"qc-think" + (live ? " live" : "")}>
      <button type="button" className="qc-think-head" onClick={() => setOpen((o) => !o)}>
        {live
          ? <i className="bi bi-arrow-repeat qc-spin"></i>
          : <i className="bi bi-lightbulb"></i>}
        <span className="qc-think-title">{live ? "Denkt nach…" : "Denkprozess"}</span>
        {tickets.length > 0 && (
          <span className="qc-think-tickets">
            · prüft {tickets.slice(0, 3).join(", ")}{tickets.length > 3 ? ` +${tickets.length - 3}` : ""}
          </span>
        )}
        <i className={"bi qc-think-caret bi-chevron-" + (open ? "up" : "down")}></i>
      </button>
      {open && (
        <div className="qc-think-body">
          {reasoning
            ? reasoning
            : <span className="qc-think-muted">Analysiert die Wissensbasis…</span>}
        </div>
      )}
    </div>
  );
}

// Row of clickable source chips. Jira sources open the ticket in a new tab;
// anything else is shown as a non-clickable file badge with a snippet tooltip.
function SourceChips({ sources }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="qc-sources">
      <span className="qc-sources-label"><i className="bi bi-link-45deg"></i>Quellen</span>
      {sources.map((s) => (
        s.url ? (
          <a
            key={s.id}
            className="qc-source"
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            title={s.snippet ? s.snippet : `Ticket ${s.label} öffnen`}
          >
            <i className="bi bi-ticket-perforated"></i>
            <span>{s.label}</span>
            <i className="bi bi-box-arrow-up-right qc-source-ext"></i>
          </a>
        ) : (
          <span key={s.id} className="qc-source qc-source-static" title={s.snippet || s.label}>
            <i className="bi bi-file-earmark-text"></i>
            <span>{s.label}</span>
          </span>
        )
      ))}
    </div>
  );
}

function QuickChat() {
  const boot = window.KNOWFLOW_QUICKCHAT || { enabled: false, models: [], hasKnowledge: false };
  const [enabled, setEnabled] = React.useState(Boolean(boot.enabled));
  const [models, setModels] = React.useState(boot.models || []);
  const [hasKnowledge, setHasKnowledge] = React.useState(Boolean(boot.hasKnowledge));
  const [jiraBaseUrl, setJiraBaseUrl] = React.useState(boot.jiraBaseUrl || "");
  const [model, setModel] = React.useState((boot.models && boot.models[0]) || "");
  const [messages, setMessages] = React.useState([]); // [{ role, content, reasoning?, sources?, thinking? }]
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const scrollRef = React.useRef(null);
  const abortRef = React.useRef(null);

  // Re-check the config on mount in case the admin changed it since page load.
  React.useEffect(() => {
    fetch("/api/quickchat/config")
      .then((r) => r.json())
      .then((c) => {
        setEnabled(Boolean(c.enabled));
        setModels(c.models || []);
        setHasKnowledge(Boolean(c.hasKnowledge));
        setJiraBaseUrl(c.jiraBaseUrl || "");
        setModel((prev) => ((c.models || []).includes(prev) ? prev : ((c.models || [])[0] || "")));
      })
      .catch(() => {});
  }, []);

  // Keep the transcript scrolled to the newest message.
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy || !model) return;
    setError(null);
    const history = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "", reasoning: "", sources: [], thinking: true }]);
    setInput("");
    setBusy(true);

    // Only user/assistant content is sent upstream — never the local
    // reasoning/sources bookkeeping fields.
    const wireHistory = history.map((m) => ({ role: m.role, content: m.content }));

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const resp = await fetch("/api/quickchat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": window.getCsrfToken ? window.getCsrfToken() : "",
        },
        body: JSON.stringify({ model, messages: wireHistory }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.error || "HTTP " + resp.status);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let rawContent = "";
      let rawReasoning = "";
      let srcAcc = [];
      let done = false;

      const flush = () => {
        const parsed = splitThinking(rawContent);
        const reasoning = [rawReasoning.trim(), parsed.reasoning].filter(Boolean).join("\n").trim();
        // Mid-stream "thinking" state: derived purely from the parse (an open
        // <think> block, or reasoning present before any answer). It is cleared
        // explicitly once the stream ends, so it must not depend on `busy` here.
        const thinking = parsed.open || (Boolean(reasoning) && !parsed.content);
        setMessages((prev) => {
          const next = prev.slice();
          next[next.length - 1] = {
            role: "assistant",
            content: parsed.content,
            reasoning,
            sources: srcAcc,
            thinking,
          };
          return next;
        });
      };

      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        // SSE events are separated by a blank line; keep the trailing partial.
        const parts = buffer.split("\n\n");
        buffer = parts.pop();
        for (const part of parts) {
          let ev = "message";
          const dataLines = [];
          for (const line of part.split("\n")) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          const data = dataLines.join("\n");
          if (!data) continue;
          if (ev === "error") {
            let m = "Streaming-Fehler.";
            try { m = JSON.parse(data).error || m; } catch (_e) { /* ignore */ }
            throw new Error(m);
          }
          if (data === "[DONE]") { done = true; break; }
          try {
            const json = JSON.parse(data);
            const choice = json.choices && json.choices[0];
            // RAG citations usually arrive at the top level of a chunk
            // (OpenWebUI) but some builds nest them; check the common spots.
            const rawSources = json.sources || json.citations
              || (choice && (choice.sources || choice.citations));
            if (Array.isArray(rawSources) && rawSources.length) {
              const norm = normalizeSources(rawSources, jiraBaseUrl);
              if (norm.length) srcAcc = norm;
            }
            const delta = choice && choice.delta;
            if (delta) {
              // Reasoning models expose scratch-work either as a dedicated field
              // (reasoning_content / reasoning) or inline via <think> tags.
              if (typeof delta.reasoning_content === "string") rawReasoning += delta.reasoning_content;
              else if (typeof delta.reasoning === "string") rawReasoning += delta.reasoning;
              if (typeof delta.content === "string") rawContent += delta.content;
            }
            flush();
          } catch (err) {
            if (err instanceof SyntaxError) continue; // keep-alive / non-JSON
            throw err;
          }
        }
      }

      // Streaming finished: clear the "thinking" flag on the final message.
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.role === "assistant") next[next.length - 1] = { ...last, thinking: false };
        return next;
      });
    } catch (err) {
      if (err.name !== "AbortError") {
        setError(err.message);
      }
      // Drop a trailing empty assistant bubble if nothing streamed.
      setMessages((prev) => {
        const next = prev.slice();
        const last = next.length ? next[next.length - 1] : null;
        if (last && last.role === "assistant") {
          if (!last.content && !last.reasoning) next.pop();
          else next[next.length - 1] = { ...last, thinking: false };
        }
        return next;
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => { if (abortRef.current) abortRef.current.abort(); };
  const clear = () => { if (!busy) { setMessages([]); setError(null); } };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const titleEl = (
    <h1 className="page-title">
      <i className="bi bi-chat-dots" style={{ marginRight: 8 }}></i>Schneller Chat
      <span className="beta-badge">Beta</span>
    </h1>
  );

  if (!enabled) {
    return (
      <>
        <div className="page-head">
          <div>
            {titleEl}
            <p className="page-sub">Temporärer Chat auf Basis der Wissensbasis</p>
          </div>
        </div>
        <div className="empty"><i className="bi bi-chat-square-dots"></i><div>Der Schnelle Chat ist derzeit nicht aktiviert.</div></div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          {titleEl}
          <p className="page-sub">
            Temporäre Unterhaltung · wird nicht gespeichert{hasKnowledge ? " · nutzt die Wissensbasis mit Quellenangaben" : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            style={{ padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 9, fontSize: 13, maxWidth: 220 }}
          >
            {models.length === 0 && <option value="">Kein Modell</option>}
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button className="btn-ghost" onClick={clear} disabled={busy || messages.length === 0}>
            <i className="bi bi-trash3"></i>Leeren
          </button>
        </div>
      </div>

      <div className="card-x chat-panel">
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && (
            <div className="empty" style={{ margin: "auto" }}>
              <i className="bi bi-chat-square-text"></i>
              <div>Stelle eine Frage, um zu starten.</div>
            </div>
          )}
          {messages.map((m, i) => {
            if (m.role === "user") {
              return <div key={i} className="chat-bubble user">{m.content}</div>;
            }
            const isLast = i === messages.length - 1;
            const showThinking = Boolean(m.reasoning) || (busy && isLast && m.thinking);
            // Fall back to the plain typing indicator only when there is no
            // thinking panel already signalling activity.
            const waiting = busy && isLast && !m.content && !m.reasoning && !showThinking;
            return (
              <div key={i} className="chat-turn">
                {showThinking && (
                  <ThinkingPanel reasoning={m.reasoning} sources={m.sources} live={busy && isLast && m.thinking} />
                )}
                {(m.content || waiting) && (
                  <div className="chat-bubble assistant">
                    {m.content || <span className="typing-dots"><i></i><i></i><i></i></span>}
                  </div>
                )}
                <SourceChips sources={m.sources} />
              </div>
            );
          })}
        </div>

        {error && <div style={{ padding: "0 18px" }}><Banner kind="err">{error}</Banner></div>}

        <div style={{ borderTop: "1px solid var(--border)", padding: 14, display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Nachricht schreiben… (Enter zum Senden, Shift+Enter für neue Zeile)"
            disabled={busy || !model}
            style={{ flex: 1, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 9, fontSize: 13.5, fontFamily: "inherit", resize: "vertical" }}
          />
          {busy ? (
            <button className="btn-ghost" onClick={stop}><i className="bi bi-stop-circle"></i>Stopp</button>
          ) : (
            <button className="btn-primary-x" onClick={send} disabled={!input.trim() || !model}><i className="bi bi-send"></i>Senden</button>
          )}
        </div>
      </div>
    </>
  );
}

window.QuickChat = QuickChat;
