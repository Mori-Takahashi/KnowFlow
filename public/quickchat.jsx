// ============================================================
// Schneller Chat (Quick Chat)
// Temporary, ephemeral chat that runs over the OpenWebUI API of the
// admin-selected knowledge base. History lives only in this component's state
// and is never persisted. The system prompt stays server-side.
// ============================================================
function QuickChat() {
  const boot = window.KNOWFLOW_QUICKCHAT || { enabled: false, models: [], hasKnowledge: false };
  const [enabled, setEnabled] = React.useState(Boolean(boot.enabled));
  const [models, setModels] = React.useState(boot.models || []);
  const [hasKnowledge, setHasKnowledge] = React.useState(Boolean(boot.hasKnowledge));
  const [model, setModel] = React.useState((boot.models && boot.models[0]) || "");
  const [messages, setMessages] = React.useState([]); // [{ role, content }]
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
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const resp = await fetch("/api/quickchat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": window.getCsrfToken ? window.getCsrfToken() : "",
        },
        body: JSON.stringify({ model, messages: history }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.error || "HTTP " + resp.status);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      let done = false;
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
            const delta = choice && choice.delta && choice.delta.content;
            if (delta) {
              acc += delta;
              setMessages((prev) => {
                const next = prev.slice();
                next[next.length - 1] = { role: "assistant", content: acc };
                return next;
              });
            }
          } catch (_e) {
            // Ignore keep-alive comments / non-JSON lines.
          }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setError(err.message);
      }
      // Drop a trailing empty assistant bubble if nothing streamed.
      setMessages((prev) => {
        const next = prev.slice();
        if (next.length && next[next.length - 1].role === "assistant" && !next[next.length - 1].content) next.pop();
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

  if (!enabled) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title"><i className="bi bi-chat-dots" style={{ marginRight: 8 }}></i>Schneller Chat</h1>
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
          <h1 className="page-title"><i className="bi bi-chat-dots" style={{ marginRight: 8 }}></i>Schneller Chat</h1>
          <p className="page-sub">
            Temporäre Unterhaltung · wird nicht gespeichert{hasKnowledge ? " · nutzt die Wissensbasis" : ""}
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
          {messages.map((m, i) => (
            <div key={i} className={"chat-bubble " + (m.role === "user" ? "user" : "assistant")}>
              {m.content || (busy && i === messages.length - 1
                ? <span className="typing-dots"><i></i><i></i><i></i></span>
                : "")}
            </div>
          ))}
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
