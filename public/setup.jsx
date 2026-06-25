// ============================================================
// Ersteinrichtung (First-Run-Setup-Wizard / Startup Screen)
// Eigenständiger Vollbild-Assistent, der NUR beim allerersten Start
// erscheint (gesteuert über /api/setup/status). Bestehende Installationen
// sehen ihn nie. Bewusst unabhängig von der .shell/Sidebar gehalten.
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

// Die vier inhaltlichen Schritte (0 = Willkommen, 5 = Fertig stehen separat).
const SETUP_STEPS = ["Passwort", "Jira", "Wissensbasis", "Zusammenfassung"];

// Die kleinen Schritt-Punkte oben in der Karte (Nummer bzw. Häkchen).
function SetupDots({ step }) {
  // Punkte gibt es nur für die inhaltlichen Schritte 1..4; Willkommen (0) und
  // Erfolg (5) zeigen keine Punktreihe, da dort kein Fortschritt nötig ist.
  return (
    <div className="setup-dots">
      {SETUP_STEPS.map((label, i) => {
        const index = i + 1; // Schritte 1..4
        const done = step > index || step === 5;
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
  const pct = Math.max(0, Math.min(100, Math.round((step / 5) * 100)));
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
  // step 0..5: 0 Willkommen, 1 Passwort, 2 Jira, 3 Wissensbasis, 4 Zusammenfassung, 5 Fertig
  const [step, setStep] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);

  // Schritt 1: Admin-Passwort (Pflicht)
  const [password, setPassword] = React.useState("");
  const [passwordRepeat, setPasswordRepeat] = React.useState("");

  // Schritt 2: Jira (optional)
  const [jiraSkipped, setJiraSkipped] = React.useState(false);
  const [baseUrl, setBaseUrl] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [apiToken, setApiToken] = React.useState("");
  const [projectKeys, setProjectKeys] = React.useState("");
  const [doneStatuses, setDoneStatuses] = React.useState("Done");
  const [reworkStatuses, setReworkStatuses] = React.useState("Überarbeiten, Updaten");
  const [webhookSecret, setWebhookSecret] = React.useState("");

  // Schritt 3: Wissensbasis (optional)
  const [targetSkipped, setTargetSkipped] = React.useState(false);
  const [owMode, setOwMode] = React.useState("dummy");
  const [targetName, setTargetName] = React.useState("Standard-Wissensbasis");
  const [targetUrl, setTargetUrl] = React.useState("");
  const [targetToken, setTargetToken] = React.useState("");
  const [knowledgeId, setKnowledgeId] = React.useState("");

  // Passwort-Validierung: beide >= 6 Zeichen und identisch.
  const passwordLongEnough = password.length >= 6;
  const passwordsMatch = password === passwordRepeat;
  const passwordValid = passwordLongEnough && passwordsMatch && passwordRepeat.length >= 6;

  // Hat der Nutzer in Schritt 2 tatsächlich Jira-Werte hinterlegt?
  const jiraHasValues = Boolean(baseUrl.trim());
  // Hat der Nutzer in Schritt 3 echte Wissensbasis-Felder befüllt?
  const targetHasValues = Boolean(targetUrl.trim() || knowledgeId.trim() || targetToken.trim());

  // Zurück: ein Schritt, niemals unter 0 und nicht aus dem Erfolgsschritt heraus.
  const goBack = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  };

  // Weiter aus den optionalen Schritten: trägt der Nutzer doch Werte ein,
  // heben wir ein zuvor gesetztes Skip-Flag wieder auf.
  const goNext = () => {
    setError(null);
    if (step === 2 && jiraHasValues) setJiraSkipped(false);
    if (step === 3 && targetHasValues) setTargetSkipped(false);
    setStep((s) => s + 1);
  };

  // Überspringen merkt sich das Flag pro Schritt und springt weiter.
  const skipStep = () => {
    setError(null);
    if (step === 2) setJiraSkipped(true);
    if (step === 3) setTargetSkipped(true);
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

      const res = await fetch("/api/setup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
      setStep(5);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // ---- Schritt-Inhalte ----------------------------------------------------

  let body;
  if (step === 0) {
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
            <i className="bi bi-shield-lock"></i>
            <span>Admin-Passwort festlegen</span>
          </div>
          <div className="setup-feature">
            <i className="bi bi-plug"></i>
            <span>Jira verbinden</span>
          </div>
          <div className="setup-feature">
            <i className="bi bi-hdd-stack"></i>
            <span>Wissensbasis wählen</span>
          </div>
        </div>
      </div>
    );
  } else if (step === 1) {
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
  } else if (step === 2) {
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
  } else if (step === 3) {
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
  } else if (step === 4) {
    // Zusammenfassung: spiegelt die getroffenen Entscheidungen inkl. Skip-Status.
    const jiraOn = !jiraSkipped && jiraHasValues;
    const targetOn = !targetSkipped && targetHasValues;
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
        </div>
      </div>
    );
  } else {
    // step === 5: Erfolg
    body = (
      <div className="setup-step setup-step-center" key="done">
        <div className="setup-check">
          <span className="setup-ring"></span>
          <i className="bi bi-check"></i>
        </div>
        <h2 className="setup-title">Alles eingerichtet!</h2>
        <p className="setup-lead">
          Du bist angemeldet. Alle Einstellungen kannst du jederzeit im
          Admin-Bereich anpassen.
        </p>
      </div>
    );
  }

  // ---- Fußzeile -----------------------------------------------------------
  // Primär-Button und Beschriftung hängen vom aktuellen Schritt ab.
  const isOptionalStep = step === 2 || step === 3;
  const canAdvance = step !== 1 || passwordValid;

  let primaryLabel = "Weiter";
  let primaryAction = goNext;
  let primaryDisabled = !canAdvance;
  if (step === 0) {
    primaryLabel = "Los geht's";
  } else if (step === 4) {
    primaryLabel = busy ? "Wird eingerichtet…" : "Setup abschließen";
    primaryAction = submit;
    primaryDisabled = busy;
  } else if (step === 5) {
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

        {step >= 1 && step <= 4 && (
          <>
            <SetupProgress step={step} />
            <SetupDots step={step} />
          </>
        )}

        <div className="setup-content">{body}</div>

        <div className="setup-footer">
          <div className="setup-footer-left">
            {step >= 1 && step <= 4 && (
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
              {step === 4 && busy && <i className="bi bi-arrow-repeat setup-spin"></i>}
              {primaryLabel}
              {step !== 4 && step !== 5 && <i className="bi bi-arrow-right"></i>}
              {step === 5 && <i className="bi bi-box-arrow-in-right"></i>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

window.SetupWizard = SetupWizard;
