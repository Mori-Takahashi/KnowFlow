// ============================================================
// Ersteinrichtung (First-Run-Setup-Wizard / Startup Screen)
// Eigenständiger Vollbild-Assistent, der NUR beim allerersten Start
// erscheint (gesteuert über /api/setup/status). Bestehende Installationen
// sehen ihn nie. Bewusst unabhängig von der .shell/Sidebar gehalten.
//
// Der Assistent ist PIN-geschützt: Beim ersten Start gibt der Server einen
// 6-stelligen PIN in der Konsole aus. Dieser muss im ersten Schritt eingegeben
// werden (POST /api/setup/verify-pin) und schaltet die restlichen Schritte frei.
// ============================================================

// --- kleine, lokal duplizierte Helfer (setup.jsx soll eigenständig sein) ---

// Wandelt eine kommagetrennte Eingabe in eine bereinigte Liste.
function setupTextToList(text) {
  return (text || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Eingabefeld im Stil der Admin-Inputs (1px Rahmen, radius 8, 9/12 Padding).
function SetupField({ label, value, onChange, type = "text", placeholder, hint, autoFocus }) {
  return (
    <div className="setup-field">
      {label && <label className="setup-label">{label}</label>}
      <input
        className="setup-input"
        type={type}
        value={value == null ? "" : value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <div className="setup-hint">{hint}</div>}
    </div>
  );
}

// Eigenständiges Fehler-Banner (setup.jsx dupliziert es bewusst lokal, statt
// sich auf die Banner-Komponente aus admin.jsx zu verlassen).
function SetupErrorBanner({ children }) {
  if (!children) return null;
  return (
    <div className="setup-banner-err">
      <i className="bi bi-exclamation-octagon"></i>
      <div>{children}</div>
    </div>
  );
}

// Die inhaltlichen Schritte (0 = Willkommen, 7 = Fertig stehen separat).
const SETUP_STEPS = ["PIN", "Passwort", "Jira", "Wissensbasis", "Server", "Zusammenfassung"];
// Indizes der Schritte für bessere Lesbarkeit.
const STEP_WELCOME = 0;
const STEP_PIN = 1;
const STEP_PASSWORD = 2;
const STEP_JIRA = 3;
const STEP_KNOWLEDGE = 4;
const STEP_SERVER = 5;
const STEP_SUMMARY = 6;
const STEP_DONE = 7;

// Die kleinen Schritt-Punkte oben in der Karte (Nummer bzw. Häkchen).
function SetupDots({ step }) {
  // Punkte gibt es nur für die inhaltlichen Schritte 1..6; Willkommen (0) und
  // Erfolg (7) zeigen keine Punktreihe, da dort kein Fortschritt nötig ist.
  return (
    <div className="setup-dots">
      {SETUP_STEPS.map((label, i) => {
        const index = i + 1; // Schritte 1..6
        const done = step > index || step === STEP_DONE;
        const active = step === index;
        const cls = "setup-dot" + (active ? " active" : "") + (done ? " done" : "");
        return (
          <div className="setup-dot-wrap" key={label}>
            <div className={cls} title={label}>
              {done ? <i className="bi bi-check"></i> : index}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Schmaler animierter Fortschrittsbalken (width-Transition in der CSS).
function SetupProgress({ step }) {
  // 0 % auf der Willkommensseite, danach gleichmäßig bis 100 % im Erfolgsschritt.
  const pct = Math.max(0, Math.min(100, Math.round((step / STEP_DONE) * 100)));
  return (
    <div className="setup-progress">
      <div className="setup-progress-fill" style={{ width: pct + "%" }}></div>
    </div>
  );
}

// ============================================================
// Haupt-Komponente
// ============================================================
function SetupWizard({ onComplete }) {
  // step 0..7: 0 Willkommen, 1 PIN, 2 Passwort, 3 Jira, 4 Wissensbasis,
  // 5 Server, 6 Zusammenfassung, 7 Fertig
  const [step, setStep] = React.useState(STEP_WELCOME);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  // Schritt 1: Konsolen-PIN (Pflicht). pinOk merkt sich die erfolgreiche Prüfung.
  const [pin, setPin] = React.useState("");
  const [pinOk, setPinOk] = React.useState(false);

  // Schritt 2: Admin-Passwort (Pflicht)
  const [password, setPassword] = React.useState("");
  const [passwordRepeat, setPasswordRepeat] = React.useState("");

  // Schritt 3: Jira (optional)
  const [jiraSkipped, setJiraSkipped] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [apiToken, setApiToken] = React.useState("");
  const [projectKeys, setProjectKeys] = React.useState("");
  const [doneStatuses, setDoneStatuses] = React.useState("Done");
  const [reworkStatuses, setReworkStatuses] = React.useState("Überarbeiten, Updaten");
  const [webhookSecret, setWebhookSecret] = React.useState("");

  // Schritt 4: Wissensbasis (optional)
  const [targetSkipped, setTargetSkipped] = React.useState(false);
  const [owMode, setOwMode] = React.useState("dummy");
  const [targetName, setTargetName] = React.useState("Standard-Wissensbasis");
  const [targetUrl, setTargetUrl] = React.useState("");
  const [targetToken, setTargetToken] = React.useState("");
  const [knowledgeId, setKnowledgeId] = React.useState("");

  // Schritt 5: Server & URLs (optional). Vorbelegt aus /api/setup/status.
  const [serverSkipped, setServerSkipped] = React.useState(false);
  const [publicBaseUrl, setPublicBaseUrl] = React.useState("");
  const [port, setPort] = React.useState("");
  const [databaseUrl, setDatabaseUrl] = React.useState("");
  const [webhookDebug, setWebhookDebug] = React.useState(false);
  const [uiDebug, setUiDebug] = React.useState(false);

  // Aktuelle Infra-Defaults vom Server laden, um den Server-Schritt vorzubefüllen.
  React.useEffect(() => {
    fetch("/api/setup/status")
      .then((r) => r.json())
      .then((d) => {
        const env = d && d.envDefaults;
        if (!env) return;
        setPublicBaseUrl(env.PUBLIC_BASE_URL || "");
        setPort(env.PORT || "");
        setDatabaseUrl(env.DATABASE_URL || "");
        setWebhookDebug(String(env.WEBHOOK_DEBUG) === "true");
        setUiDebug(String(env.UI_DEBUG) === "true");
      })
      .catch(() => {});
  }, []);

  // PIN-Validierung: genau 6 Ziffern.
  const pinValid = /^[0-9]{6}$/.test(pin);

  // Passwort-Validierung: beide >= 6 Zeichen und identisch.
  const passwordLongEnough = password.length >= 6;
  const passwordsMatch = password === passwordRepeat;
  const passwordValid = passwordLongEnough && passwordsMatch && passwordRepeat.length >= 6;

  // Hat der Nutzer in Schritt 3 tatsächlich Jira-Werte hinterlegt?
  const jiraHasValues = Boolean(baseUrl.trim());
  // Hat der Nutzer in Schritt 4 echte Wissensbasis-Felder befüllt?
  const targetHasValues = Boolean(targetUrl.trim() || knowledgeId.trim() || targetToken.trim());

  // Zurück: ein Schritt, niemals unter 0 und nicht aus dem Erfolgsschritt heraus.
  // Aus dem PIN-Schritt zurück auf Willkommen ist erlaubt.
  const goBack = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  };

  // Prüft den PIN gegen das Backend und schaltet bei Erfolg den nächsten Schritt
  // frei. Erst danach ist eine Setup-Sitzung aktiv (Cookie), die /complete braucht.
  const verifyPin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/verify-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      setPinOk(true);
      setStep(STEP_PASSWORD);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Weiter aus den optionalen Schritten: trägt der Nutzer doch Werte ein,
  // heben wir ein zuvor gesetztes Skip-Flag wieder auf.
  const goNext = () => {
    setError(null);
    if (step === STEP_JIRA && jiraHasValues) setJiraSkipped(false);
    if (step === STEP_KNOWLEDGE && targetHasValues) setTargetSkipped(false);
    if (step === STEP_SERVER) setServerSkipped(false);
    setStep((s) => s + 1);
  };

  // Überspringen merkt sich das Flag pro Schritt und springt weiter.
  const skipStep = () => {
    setError(null);
    if (step === STEP_JIRA) setJiraSkipped(true);
    if (step === STEP_KNOWLEDGE) setTargetSkipped(true);
    if (step === STEP_SERVER) setServerSkipped(true);
    setStep((s) => s + 1);
  };

  // Schickt die gesammelten Eingaben an das Backend und schaltet bei Erfolg
  // in den Abschluss-Schritt. Auto-Login passiert serverseitig per Cookie.
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = { password, openwebuiMode: owMode };

      // Jira nur senden, wenn nicht übersprungen UND eine Base-URL vorhanden ist.
      if (!jiraSkipped && jiraHasValues) {
        payload.jira = {
          baseUrl,
          email,
          apiToken,
          projectKeys: setupTextToList(projectKeys),
          doneStatuses: setupTextToList(doneStatuses),
          reworkStatuses: setupTextToList(reworkStatuses),
          webhookSecret,
        };
      }

      // Wissensbasis nur senden, wenn nicht übersprungen UND mindestens ein Feld
      // (URL / Knowledge-ID / Token) befüllt ist.
      if (!targetSkipped && targetHasValues) {
        payload.target = {
          name: targetName,
          url: targetUrl,
          token: targetToken,
          knowledgeId: knowledgeId,
        };
      }

      // Server-/Infra-Werte nur senden, wenn der Schritt nicht übersprungen wurde.
      // Das Backend schreibt sie in die .env (gilt erst nach einem Neustart).
      if (!serverSkipped) {
        payload.env = {
          PUBLIC_BASE_URL: publicBaseUrl,
          PORT: port,
          DATABASE_URL: databaseUrl,
          WEBHOOK_DEBUG: webhookDebug ? "true" : "false",
          UI_DEBUG: uiDebug ? "true" : "false",
        };
      }

      const res = await fetch("/api/setup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      setStep(STEP_DONE);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // ---- Schritt-Inhalte ----------------------------------------------------

  let body;
  if (step === STEP_WELCOME) {
    body = (
      <div className="setup-step setup-step-center" key="welcome">
        <div className="setup-logo">JB</div>
        <h2 className="setup-title">Willkommen beim KnowFlow</h2>
        <p className="setup-lead">
          Lass uns deinen Bot in wenigen Schritten startklar machen. Alles lässt
          sich später im Admin-Bereich ändern.
        </p>
        <div className="setup-features">
          <div className="setup-feature">
            <i className="bi bi-key"></i>
            <span>Mit PIN aus der Konsole anmelden</span>
          </div>
          <div className="setup-feature">
            <i className="bi bi-shield-lock"></i>
            <span>Admin-Passwort festlegen</span>
          </div>
          <div className="setup-feature">
            <i className="bi bi-plug"></i>
            <span>Jira verbinden</span>
          </div>
          <div className="setup-feature">
            <i className="bi bi-hdd-stack"></i>
            <span>Wissensbasis & Server konfigurieren</span>
          </div>
        </div>
      </div>
    );
  } else if (step === STEP_PIN) {
    body = (
      <div className="setup-step" key="pin">
        <h2 className="setup-title">Setup-PIN</h2>
        <p className="setup-lead">
          Beim Start hat der Server einen 6-stelligen PIN in der Konsole
          ausgegeben. Gib ihn hier ein, um die Einrichtung freizuschalten.
        </p>
        {error && <SetupErrorBanner>{error}</SetupErrorBanner>}
        <SetupField
          label="6-stelliger PIN"
          value={pin}
          onChange={(v) => setPin(v.replace(/[^0-9]/g, "").slice(0, 6))}
          placeholder="000000"
          hint="Steht in der Server-Konsole unter „KNOWFLOW ERSTEINRICHTUNG — SETUP-PIN“."
          autoFocus
        />
      </div>
    );
  } else if (step === STEP_PASSWORD) {
    body = (
      <div className="setup-step" key="password">
        <h2 className="setup-title">Admin-Passwort</h2>
        <p className="setup-lead">
          Mindestens 6 Zeichen. Damit meldest du dich künftig im Admin-Bereich an.
        </p>
        <SetupField
          label="Passwort"
          type="password"
          value={password}
          onChange={setPassword}
          placeholder="Mindestens 6 Zeichen"
          autoFocus
        />
        <SetupField
          label="Passwort wiederholen"
          type="password"
          value={passwordRepeat}
          onChange={setPasswordRepeat}
          placeholder="Passwort erneut eingeben"
        />
        {passwordRepeat.length > 0 && !passwordsMatch && (
          <div className="setup-inline-err">Die Passwörter stimmen nicht überein.</div>
        )}
        {password.length > 0 && !passwordLongEnough && (
          <div className="setup-inline-err">Das Passwort muss mindestens 6 Zeichen lang sein.</div>
        )}
      </div>
    );
  } else if (step === STEP_JIRA) {
    body = (
      <div className="setup-step" key="jira">
        <h2 className="setup-title">Jira-Verbindung</h2>
        <p className="setup-lead">
          Verbinde dein Jira Cloud-Projekt. Du kannst diesen Schritt überspringen
          und später im Admin-Bereich nachholen.
        </p>
        <SetupField
          label="Base URL"
          value={baseUrl}
          onChange={setBaseUrl}
          placeholder="https://workspace.atlassian.net"
          autoFocus
        />
        <SetupField label="E-Mail" value={email} onChange={setEmail} placeholder="name@beispiel.de" />
        <SetupField
          label="API-Token"
          type="password"
          value={apiToken}
          onChange={setApiToken}
          placeholder="Jira API-Token"
        />
        <SetupField
          label="Projekt-Schlüssel"
          value={projectKeys}
          onChange={setProjectKeys}
          placeholder="KAN, KNOW"
          hint="Kommagetrennt. Nur Tickets aus diesen Projekten werden verarbeitet."
        />
        <SetupField
          label="Done-Status"
          value={doneStatuses}
          onChange={setDoneStatuses}
          placeholder="Done"
          hint="Kommagetrennt. Diese Status lösen die Übernahme aus."
        />
        <SetupField
          label="Überarbeiten-Status"
          value={reworkStatuses}
          onChange={setReworkStatuses}
          placeholder="Überarbeiten, Updaten"
          hint="Kommagetrennt. Diese Status markieren ein Ticket als zu überarbeiten."
        />
        <SetupField
          label="Webhook-Secret (optional)"
          type="password"
          value={webhookSecret}
          onChange={setWebhookSecret}
          placeholder="Gemeinsames Secret zur Signaturprüfung"
        />
      </div>
    );
  } else if (step === STEP_KNOWLEDGE) {
    body = (
      <div className="setup-step" key="knowledge">
        <h2 className="setup-title">Wissensbasis</h2>
        <p className="setup-lead">
          Wähle den Betriebsmodus und richte optional eine erste Wissensbasis ein.
          Auch das lässt sich später jederzeit anpassen.
        </p>
        <div className="setup-choices">
          <button
            type="button"
            className={"setup-choice" + (owMode === "dummy" ? " active" : "")}
            onClick={() => setOwMode("dummy")}
          >
            <div className="setup-choice-head">
              <i className="bi bi-box"></i>
              <span>Dummy</span>
              {owMode === "dummy" && <i className="bi bi-check-circle-fill setup-choice-check"></i>}
            </div>
            <div className="setup-choice-desc">
              Empfohlen zum Ausprobieren. Es werden keine externen Aufrufe getätigt.
            </div>
          </button>
          <button
            type="button"
            className={"setup-choice" + (owMode === "real" ? " active" : "")}
            onClick={() => setOwMode("real")}
          >
            <div className="setup-choice-head">
              <i className="bi bi-cloud-arrow-up"></i>
              <span>Real</span>
              {owMode === "real" && <i className="bi bi-check-circle-fill setup-choice-check"></i>}
            </div>
            <div className="setup-choice-desc">
              Echte OpenWebUI-Uploads gegen die angegebene URL.
            </div>
          </button>
        </div>
        <div className="setup-divider"></div>
        <SetupField
          label="Name"
          value={targetName}
          onChange={setTargetName}
          placeholder="Standard-Wissensbasis"
        />
        <SetupField
          label="OpenWebUI URL"
          value={targetUrl}
          onChange={setTargetUrl}
          placeholder="https://chat.example.com"
        />
        <SetupField
          label="API-Token"
          type="password"
          value={targetToken}
          onChange={setTargetToken}
          placeholder="OpenWebUI API-Token"
        />
        <SetupField
          label="Knowledge-ID"
          value={knowledgeId}
          onChange={setKnowledgeId}
          placeholder="ID der Wissensdatenbank"
        />
      </div>
    );
  } else if (step === STEP_SERVER) {
    body = (
      <div className="setup-step" key="server">
        <h2 className="setup-title">Server & URLs</h2>
        <p className="setup-lead">
          Diese Werte werden in die <code>.env</code> geschrieben. Änderungen an
          URL, Port oder Datenbankpfad greifen erst nach einem Neustart. Im Zweifel
          einfach überspringen — die Standardwerte funktionieren lokal.
        </p>
        <SetupField
          label="Öffentliche Basis-URL"
          value={publicBaseUrl}
          onChange={setPublicBaseUrl}
          placeholder="http://localhost:3000"
          hint="Wird für Webhook-Links und Kommentare verwendet."
          autoFocus
        />
        <SetupField
          label="Port"
          value={port}
          onChange={(v) => setPort(v.replace(/[^0-9]/g, "").slice(0, 5))}
          placeholder="3000"
        />
        <SetupField
          label="Datenbank-Pfad"
          value={databaseUrl}
          onChange={setDatabaseUrl}
          placeholder="./data/knowflow.sqlite"
        />
        <div className="setup-field">
          <label className="setup-label setup-check-label">
            <input
              type="checkbox"
              checked={webhookDebug}
              onChange={(e) => setWebhookDebug(e.target.checked)}
            />
            <span>Webhook-Debug aktivieren</span>
          </label>
          <label className="setup-label setup-check-label">
            <input
              type="checkbox"
              checked={uiDebug}
              onChange={(e) => setUiDebug(e.target.checked)}
            />
            <span>UI-Debug-Panel aktivieren</span>
          </label>
        </div>
      </div>
    );
  } else if (step === STEP_SUMMARY) {
    // Zusammenfassung: spiegelt die getroffenen Entscheidungen inkl. Skip-Status.
    const jiraOn = !jiraSkipped && jiraHasValues;
    const targetOn = !targetSkipped && targetHasValues;
    const serverOn = !serverSkipped;
    body = (
      <div className="setup-step" key="summary">
        <h2 className="setup-title">Zusammenfassung</h2>
        <p className="setup-lead">Prüfe deine Einstellungen und schließe die Einrichtung ab.</p>
        {error && <SetupErrorBanner>{error}</SetupErrorBanner>}
        <div className="setup-summary">
          <div className="setup-summary-row">
            <i className="bi bi-check-circle-fill setup-sum-ok"></i>
            <span className="setup-sum-label">Admin-Passwort</span>
            <span className="setup-sum-val">gesetzt</span>
          </div>
          <div className="setup-summary-row">
            <i className={"bi " + (jiraOn ? "bi-check-circle-fill setup-sum-ok" : "bi-dash-circle setup-sum-skip")}></i>
            <span className="setup-sum-label">Jira</span>
            <span className="setup-sum-val">{jiraOn ? baseUrl : "übersprungen"}</span>
          </div>
          <div className="setup-summary-row">
            <i className="bi bi-check-circle-fill setup-sum-ok"></i>
            <span className="setup-sum-label">Modus</span>
            <span className="setup-sum-val">{owMode}</span>
          </div>
          <div className="setup-summary-row">
            <i className={"bi " + (targetOn ? "bi-check-circle-fill setup-sum-ok" : "bi-dash-circle setup-sum-skip")}></i>
            <span className="setup-sum-label">Wissensbasis</span>
            <span className="setup-sum-val">
              {targetOn ? (targetName || targetUrl || "konfiguriert") : "übersprungen"}
            </span>
          </div>
          <div className="setup-summary-row">
            <i className={"bi " + (serverOn ? "bi-check-circle-fill setup-sum-ok" : "bi-dash-circle setup-sum-skip")}></i>
            <span className="setup-sum-label">Server</span>
            <span className="setup-sum-val">
              {serverOn ? (publicBaseUrl || "Standardwerte") : "übersprungen"}
            </span>
          </div>
        </div>
      </div>
    );
  } else {
    // step === STEP_DONE: Erfolg
    body = (
      <div className="setup-step setup-step-center" key="done">
        <div className="setup-check">
          <span className="setup-ring"></span>
          <i className="bi bi-check"></i>
        </div>
        <h2 className="setup-title">Alles eingerichtet!</h2>
        <p className="setup-lead">
          Du bist angemeldet. Alle Einstellungen kannst du jederzeit im
          Admin-Bereich anpassen. Server-Änderungen (URL, Port, Datenbank) greifen
          nach dem nächsten Neustart.
        </p>
      </div>
    );
  }

  // ---- Fußzeile -----------------------------------------------------------
  // Primär-Button und Beschriftung hängen vom aktuellen Schritt ab.
  const isOptionalStep = step === STEP_JIRA || step === STEP_KNOWLEDGE || step === STEP_SERVER;

  let primaryLabel = "Weiter";
  let primaryAction = goNext;
  let primaryDisabled = false;
  if (step === STEP_WELCOME) {
    primaryLabel = "Los geht's";
  } else if (step === STEP_PIN) {
    primaryLabel = busy ? "Prüfe PIN…" : "PIN bestätigen";
    primaryAction = verifyPin;
    primaryDisabled = !pinValid || busy;
  } else if (step === STEP_PASSWORD) {
    primaryDisabled = !passwordValid;
  } else if (step === STEP_SUMMARY) {
    primaryLabel = busy ? "Wird eingerichtet…" : "Setup abschließen";
    primaryAction = submit;
    primaryDisabled = busy;
  } else if (step === STEP_DONE) {
    primaryLabel = "Zum Dashboard";
    primaryAction = onComplete;
    primaryDisabled = false;
  }

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <div className="setup-header">
          <div className="brand-mark setup-brand-mark">JB</div>
          <div className="setup-header-text">KnowFlow · Ersteinrichtung</div>
        </div>

        {step >= STEP_PIN && step <= STEP_SUMMARY && (
          <>
            <SetupProgress step={step} />
            <SetupDots step={step} />
          </>
        )}

        <div className="setup-content">{body}</div>

        <div className="setup-footer">
          <div className="setup-footer-left">
            {step >= STEP_PIN && step <= STEP_SUMMARY && (
              <button className="btn-ghost" onClick={goBack}>
                <i className="bi bi-arrow-left"></i>Zurück
              </button>
            )}
          </div>
          <div className="setup-footer-right">
            {isOptionalStep && (
              <button className="setup-skip" onClick={skipStep}>
                Überspringen — später im Admin-Bereich einstellbar
              </button>
            )}
            <button className="btn-primary-x setup-primary" disabled={primaryDisabled} onClick={primaryAction}>
              {(step === STEP_SUMMARY || step === STEP_PIN) && busy && <i className="bi bi-arrow-repeat setup-spin"></i>}
              {primaryLabel}
              {step !== STEP_SUMMARY && step !== STEP_DONE && step !== STEP_PIN && <i className="bi bi-arrow-right"></i>}
              {step === STEP_DONE && <i className="bi bi-box-arrow-in-right"></i>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

window.SetupWizard = SetupWizard;
