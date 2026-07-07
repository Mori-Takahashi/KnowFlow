# KnowFlow — Technische Dokumentation

Diese Seite richtet sich an **Admins und Entwickler:innen**: Installation,
Konfiguration, Jira-Webhook, API und Troubleshooting. Für einen einfachen
Überblick siehe die [README](../README.md), für die Anwendersicht das
[Handbuch „Was ist KnowFlow?"](../Was-ist-KnowFlow.md).

KnowFlow ist ein Node.js-Service, der Jira-Tickets beim Statuswechsel auf
**Erledigt** automatisch als Markdown-Wissensartikel in eine oder mehrere
**Open WebUI**-Wissensbasen überträgt. Routing-Regeln, Feld-Zuordnung und
Verbindungs-Daten werden zur Laufzeit über ein passwortgeschütztes
**Admin-Dashboard** verwaltet und verschlüsselt in SQLite abgelegt. Eine
Live-Dashboard-WebUI (Bootstrap 5, React via CDN, Socket.IO) zeigt
Pipeline-Stand, Service-Health und einen Aktivitäts-Feed in Echtzeit.

## Inhalt

- [Funktionsumfang](#funktionsumfang)
- [Anhänge, MCP-Verbindungen und Soft-Delete](#anhänge-mcp-verbindungen-und-soft-delete)
- [Architektur](#architektur)
- [Voraussetzungen](#voraussetzungen)
- [Schnellstart](#schnellstart)
- [Konfiguration](#konfiguration)
- [Admin-Dashboard](#admin-dashboard)
- [Updates & Versionsbanner](#updates--versionsbanner)
- [Jira-Webhook einrichten](#jira-webhook-einrichten)
- [Open-WebUI-Dummy-Modus](#open-webui-dummy-modus)
- [API & Socket.IO](#api--socketio)
- [Webhook ohne echte Jira-Instanz simulieren](#webhook-ohne-echte-jira-instanz-simulieren)
- [Projektstruktur](#projektstruktur)
- [Troubleshooting](#troubleshooting)

## Funktionsumfang

- **Webhook-Ingest** für `jira:issue_updated` mit Secret-Validierung und
  Changelog-Filter (verhindert Endlosschleifen durch eigene Kommentare).
- **3-Schritt-Pipeline**: Issue aus Jira laden → Markdown erzeugen & in SQLite
  speichern → Datei in Open WebUI hochladen und der Wissensbasis hinzufügen.
- **Jira-Kommentare** in Atlassian Document Format (ADF) bei Empfang, Erfolg
  und Fehler — inkl. `@mention` des Reporters und Link zum Dashboard.
- **Multi-Wissensbasen-Routing** mit Regel-Builder (`wenn Feld X Operator Y
  Wert Z → Wissensbasis(en)`), Fallback-Ziel und Live-Vorschau.
- **Admin-Dashboard** für Jira-Verbindung, Feld-Zuordnung, Wissensbasen,
  Routing-Regeln, Markdown-Vorlage und Passwort-Änderung.
- **Danger Zone** im Admin-Dashboard: Webhook-Verarbeitung pausieren/aktivieren,
  Aktivitäts-Feed leeren, alle Tickets & deren Wissen löschen, Konfiguration auf
  den Auslieferungszustand zurücksetzen und den Dienst neu starten — destruktive
  Aktionen werden per Admin-Passwort bestätigt.
- **Zugriffssteuerung** (Admin-Tab „Zugriff & Nutzer"): optionale Bearer-Token-
  Authentifizierung pro MCP-Verbindung, separates Benutzer-Login mit granularen
  Rechten (Einstellungen einsehen/bearbeiten, Ticket-Lebenszyklus verwalten) und
  eine umschaltbare Dashboard-Sperre, die das gesamte Dashboard erst nach
  Anmeldung sichtbar macht.
- **Open-WebUI-Dummy-Modus** für lokale Tests ohne externe API.
- **Live-WebUI** mit Pipeline-Funnel, Throughput, Ticketliste, Detailansicht
  und Aktivitäts-Feed via Socket.IO.

## Anhänge, MCP-Verbindungen und Soft-Delete

### Anhänge

Beim Laden eines Tickets (Schritt 1) werden die Jira-Anhänge des Issues
heruntergeladen und lokal gespeichert (Standard: `data/attachments/<TICKET>/`,
konfigurierbar über `ATTACHMENTS_DIR`). Dateien über dem Größenlimit
(`ATTACHMENT_MAX_BYTES`, Standard 20 MiB) werden nicht geladen, sondern als
`skipped_too_large` vermerkt. Ein fehlgeschlagener Anhang bricht die Pipeline
nicht ab — es wird lediglich eine Warnung in den Aktivitäts-Feed geschrieben.

- Die gespeicherten Anhänge werden im generierten Markdown unter `## Anhänge`
  als Download-Links aufgeführt (abschaltbar über die Markdown-Vorlage).
- Download-Endpunkt: `GET /api/attachments/:jiraId/:attachmentId`.
- In der Ticket-Detailansicht erscheinen die Anhänge als Download-Liste.

### MCP-Verbindungen

Sechs feste **MCP-Verbindungen** (Model Context Protocol) stellen das
Ticket-Wissen für externe MCP-Clients bereit. Die IDs (Slugs) sind
unveränderlich; Titel und Beschreibung sind im Admin-Dashboard
(Tab **MCP-Verbindungen**) frei wählbar.

- **All-in-One** (`all`) — enthält das Wissen aller aktiven Tickets.
- **Verbindung 1-5** (`mcp-1` … `mcp-5`) — Tickets werden ihnen über
  Routing-Regeln zugeordnet (eigene Checkbox-Gruppe im Regel-Editor). Routing
  kann ein Ticket auch ausschließlich an MCP-Verbindungen senden (ohne
  Open-WebUI-Ziel).
- Endpunkt je Verbindung: `POST <PUBLIC_BASE_URL>/mcp/<id>` (statusloser
  Streamable-HTTP-Transport). Werkzeuge: `search_knowledge`, `list_knowledge`,
  `read_knowledge`, `list_attachments` (gibt direkte Download-Links der Anhänge
  aus und markiert Bilder) und `show_images` (zeigt die Bilder eines Tickets
  inline an und liefert deren Links); Ressourcen: `knowledge://{jiraId}` und
  `attachment://{jiraId}/{attachmentId}`.
- **Fehler-Rückmeldung (optional, pro Verbindung)**: Ist im Admin-Tab
  **MCP-Verbindungen** „Fehler-Rückmeldung erlauben" für eine Verbindung aktiviert
  (Standard AUS), stellt sie zusätzlich das schreibende Werkzeug
  `report_inaccuracy` bereit. Bemerkt ein Nutzer im Chat eine Ungenauigkeit
  („das stimmt nicht so ganz"), fragt der Client nach, *was genau* nicht stimmt
  (und optional die richtige Angabe), und KnowFlow schreibt das als Kommentar an
  das Ursprungs-Ticket (`@mention` des Reporters + Dashboard-Link). Ist ein
  „Wird überarbeitet"-Status konfiguriert (`JIRA_REWORK_STATUSES`), wird das Ticket
  zusätzlich dorthin verschoben. Der Kommentar/Statuswechsel löst dank des
  Webhook-Changelog-Filters **keine** erneute Pipeline aus; die Meldung erscheint
  im Aktivitäts-Feed (Quelle `MCP`).
- Übersicht in der WebUI: Tab **MCP** (Endpunkt kopieren, Wissensumfang,
  Beschreibung). Verbindungs-Liste auch über `GET /api/mcp/connections`.
- **Authentifizierung (optional, pro Verbindung)**: Im Admin-Tab
  **MCP-Verbindungen** kann je Verbindung „Authentifizierung erforderlich"
  aktiviert werden. Dann ist `POST /mcp/<id>` auf zwei Wegen nutzbar:
  - **OAuth 2.1 (für den Claude-Connector)**: KnowFlow ist selbst ein
    OAuth-Authorization-Server. Im Claude-Dialog „Benutzerdefinierten Connector
    hinzufügen" genügt die **URL** `<PUBLIC_BASE_URL>/mcp/<id>` (Client-ID/Secret
    leer lassen). Beim Verbinden öffnet sich ein KnowFlow-Login-Fenster; nach der
    Anmeldung (Admin- oder Benutzer-Passwort) ist die Verbindung autorisiert.
    Discovery-Endpunkte: `/.well-known/oauth-protected-resource/mcp/<id>` und
    `/.well-known/oauth-authorization-server`; Flow: Authorization Code + PKCE
    (`S256`) mit Dynamic Client Registration (`/oauth/register`, `/oauth/authorize`,
    `/oauth/token`).
  - **Statisches Bearer-Token (für Clients mit eigenem Header)**: Pro Verbindung
    lässt sich ein Token erzeugen, das als `Authorization: Bearer <token>` (oder
    Header `x-mcp-token`) mitgesendet wird — nützlich z. B. für `mcp-remote` oder
    den API-MCP-Connector. Es kann angezeigt, kopiert und neu erzeugt werden.

  Ohne gültige OAuth- **oder** Bearer-Authentifizierung antwortet der Endpunkt
  mit `401` (inkl. `WWW-Authenticate`-Pointer auf die Metadaten). Hinweis: Der
  claude.ai-Web-Connector unterstützt **kein** statisches Bearer-Token-Feld —
  dort wird der OAuth-Weg verwendet.

### Zugriffssteuerung, Benutzerrolle & Dashboard-Sperre

Im Admin-Tab **Zugriff & Nutzer** lassen sich drei optionale Schutzebenen
einstellen:

- **Dashboard-Sperre**: Ist sie aktiv, sind das gesamte Dashboard und die
  Live-Daten (REST-API und Socket.IO) erst nach Anmeldung sichtbar. Bis zur
  Anmeldung ersetzt ein Vollbild-Login das Dashboard. So kann nicht jeder
  einsehen, welche Daten fließen.
- **Benutzer-Login**: Neben dem Admin-Passwort kann ein separates
  **Benutzer-Passwort** vergeben werden. Beide Logins laufen über dieselbe
  Anmeldung; die Rolle ergibt sich aus dem verwendeten Passwort.
- **Benutzer-Rechte**: Pro Benutzerrolle wird festgelegt, ob Einstellungen
  eingesehen, Einstellungen bearbeitet und/oder der Ticket-Lebenszyklus
  geändert werden dürfen. Admins haben stets alle Rechte; die destruktiven
  Aktionen der Danger Zone sowie die Update- und Zugriffs-Einstellungen bleiben
  admin-exklusiv.

### Soft-Delete (veraltet / gelöscht / reaktivieren)

Jedes Ticket hat einen Lebenszyklus (`active`, `obsolete`, `deleted`).

- **Obsolet** und **Löschen** (in der Ticket-Detailansicht, Abschnitt
  **Lebenszyklus**) entfernen das Wissen aus allen Open-WebUI-Zielen
  (`removeFromKnowledge` + `deleteFile`) und nehmen das Ticket aus den
  MCP-Verbindungen.
- **Reaktivieren** setzt den Lebenszyklus zurück und startet die Pipeline neu.
- Webhooks und manuelles Retry werden für nicht-aktive Tickets ignoriert.
- Die Lebenszyklus-Aktionen sind dem Admin vorbehalten oder Benutzern mit dem
  Recht „Ticket-Lebenszyklus verwalten" (siehe Abschnitt Zugriffssteuerung);
  fehlt das Recht, erscheint der Hinweis, sich zuerst im Tab Einstellungen
  anzumelden.

## Architektur

```
Jira Cloud  ──webhook──▶  Express (POST /webhook/jira)
                                  │
                                  ▼
                          workflowService (3 Schritte)
                                  │
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
           jiraService    markdownService   openwebuiService
                 │                                 │
                 ▼                                 ▼
            Jira REST API               Open WebUI (real) /
                                        SQLite-Dummy
                                  │
                                  ▼
                           Socket.IO ──▶ WebUI (public/)
```

## Voraussetzungen

- **Node.js 20+** (`node --watch` wird im `dev`-Script genutzt)
- **better-sqlite3** — wird beim `npm install` als Prebuilt geladen. Schlägt
  das fehl, werden Build-Tools (Python, make, g++) benötigt.
- **Atlassian-Account** mit API-Token
  (`id.atlassian.com/manage-profile/security/api-tokens`)
- **Öffentlich erreichbare HTTPS-URL** für den Jira-Webhook (z. B. Cloudflare
  Tunnel oder ngrok). Jira Cloud erreicht keine lokalen Adressen.

## Schnellstart

```bash
git clone <repo>
cd KnowFlow
npm install
npm start
```

Es ist **keine `.env` nötig**: Fehlt sie, generiert KnowFlow beim ersten Start
automatisch die nötigen Secrets (`SETTINGS_ENCRYPTION_KEY`, `SESSION_SECRET`),
legt eine `.env` an und startet in den Browser-Setup-Modus. Wer die Werte lieber
selbst setzt, kopiert vorab `cp .env.example .env` und trägt sie ein.

Dashboard öffnen: <http://localhost:3000>
Beim allerersten Start erscheint der **Setup-Assistent** (siehe unten). Danach
Login via Sidebar-Eintrag **„Einstellungen"** mit dem im Setup gewählten Passwort
(bzw. dem `ADMIN_PASSWORD`, falls vorgegeben).

### Ersteinrichtung ohne `.env` (Browser-Setup + Konsolen-PIN)

Ist beim ersten Start **kein** `ADMIN_PASSWORD` gesetzt, erscheint beim ersten
Aufruf des Dashboards automatisch ein Setup-Assistent, der Schritt für Schritt
durch die Grundeinrichtung führt.

**PIN-Schutz:** Solange die Ersteinrichtung aussteht, gibt der Server bei jedem
Start einen **6-stelligen PIN** in der Konsole aus:

```
========================================================
  KNOWFLOW ERSTEINRICHTUNG — SETUP-PIN
========================================================
  Setup im Browser öffnen:  http://localhost:3000
  PIN für die Anmeldung:    123456
========================================================
```

Dieser PIN muss im ersten Schritt des Assistenten eingegeben werden und schaltet
die restlichen Schritte frei (so kann nur jemand mit Zugriff auf die Server-Konsole
das Setup durchführen). Der PIN gilt nur für den jeweiligen Serverstart und
rotiert bei jedem Neustart, bis das Setup abgeschlossen ist.

Der Assistent führt durch: **PIN** → Admin-Passwort → optional Jira-Verbindung →
optional erste Wissensbasis → optional **Server & URLs** (`PUBLIC_BASE_URL`,
`PORT`, `DATABASE_URL`, Debug-Flags; werden in die `.env` geschrieben und greifen
nach dem nächsten Neustart) → Zusammenfassung. Nach Abschluss ist man direkt
angemeldet; alle Einstellungen bleiben später im Admin-Dashboard änderbar.
Bestehende Installationen (Admin-Passwort vorhanden) sehen den Assistenten nie —
das Seeding über die `JIRA_*`-/`OPENWEBUI_*`-Variablen wird weiterhin unterstützt.

### Mit Docker

```bash
cp .env.example .env
docker compose up -d
```

Das Image baut auf `node:22-bookworm-slim` auf, legt `/app/data` als Volume an
und exponiert Port `3000`. Ein Healthcheck pingt regelmäßig den HTTP-Root.

## Konfiguration

### Pflicht

| Variable                  | Beschreibung |
|---------------------------|--------------|
| `SETTINGS_ENCRYPTION_KEY` | Master-Key (≥ 16 Zeichen) für AES-Verschlüsselung der DB-Tokens. **Nicht nachträglich ändern** — gespeicherte Tokens werden sonst unlesbar. |
| `ADMIN_PASSWORD`          | Initiales Admin-Passwort. Wird beim ersten Start gehasht in die DB übernommen und schaltet den Login frei. Optional — ohne diese Variable übernimmt der [Setup-Assistent](#ersteinrichtung-ohne-env-browser-setup--konsolen-pin) die Ersteinrichtung im Browser. |

### Seed beim Erststart (danach im Dashboard pflegbar)

| Variable                  | Beschreibung |
|---------------------------|--------------|
| `JIRA_BASE_URL`           | `https://<workspace>.atlassian.net` |
| `JIRA_EMAIL`              | Atlassian-Account-E-Mail |
| `JIRA_API_TOKEN`          | API-Token aus dem Atlassian-Profil |
| `JIRA_PROJECT_KEYS`       | Kommagetrennte Projekt-Keys (`KNOW,DOC,WIKI`) |
| `JIRA_DONE_STATUS`        | Trigger-Status, kommagetrennt möglich (`Done,Erledigt,Fertig`) |
| `JIRA_REWORK_STATUSES`    | Status für „Wird überarbeitet" (nur UI-Markierung) |
| `JIRA_WEBHOOK_SECRET`     | Optional. Wenn gesetzt, muss Header `X-KnowFlow-Secret` oder `?secret=` passen. |
| `OPENWEBUI_MODE`          | `dummy` (lokaler Mock) oder `real` |
| `OPENWEBUI_URL` / `_TOKEN` / `_KNOWLEDGE_ID` | Werte der initialen Standard-Wissensbasis |

> Nach dem ersten Seeding werden die `JIRA_*`/`OPENWEBUI_*`-Werte **nicht mehr
> gelesen**. Änderungen erfolgen ausschließlich im Admin-Dashboard. Für ein
> erneutes Seeding kann die SQLite-Datei gelöscht und der Server neu gestartet
> werden.

### Optionale Server-Einstellungen

| Variable          | Default                 | Beschreibung |
|-------------------|-------------------------|--------------|
| `PORT`            | `3000`                  | HTTP-Port |
| `PUBLIC_BASE_URL` | `http://localhost:PORT` | In Jira-Kommentaren verlinkt |
| `DATABASE_URL`    | `./data/knowflow.sqlite` | SQLite-Pfad |
| `SESSION_SECRET`  | `SETTINGS_ENCRYPTION_KEY` | Signier-Secret für Session-Cookies |
| `DEBUG`           | _(leer)_                | z. B. `knowflow:*` für ausführliches Logging |
| `WEBHOOK_DEBUG`   | `false`                 | Pro Webhook-Request einen Diagnose-Block ausgeben |
| `UI_DEBUG`        | `false`                 | Debug-Panel in der WebUI (manuelle Pipeline-Trigger, simulierte Service-Ausfälle). Nicht für Produktion. |

## Admin-Dashboard

Über die Sidebar erreichbar (Login mit `ADMIN_PASSWORD`):

- **Allgemein** — Jira-Verbindung und OpenWebUI-Modus.
- **Feld-Zuordnung** — Auto-Discovery der verfügbaren Jira-Felder. Zuordnung
  von Beschreibung, Lösung, Ziel-Bot, Kategorie, Stichwort und Hinweis.
- **Wissensbasen** — beliebig viele Open-WebUI-Ziele mit eigenem Token und
  Knowledge-ID, jeweils mit Verbindungs-Test.
- **Routing-Regeln** — Regel-Builder mit Live-Vorschau, mehrere Ziele pro
  Regel möglich. Neben den positiven **Bedingungen** lässt sich pro Regel ein
  **Ignorieren**-Filter setzen: Trifft dieser zu, wird die Regel für das Ticket
  übersprungen. So kann man breit routen (z. B. „alles") und einzelne
  Tags/Labels gezielt ausnehmen, ohne alle übrigen aufzählen zu müssen. Trifft
  keine Regel zu, wird das **Fallback-Ziel** verwendet.
- **MCP-Verbindungen** — Titel/Beschreibung, Authentifizierung und
  Fehler-Rückmeldung der sechs MCP-Verbindungen.
- **RAG** — optionale semantische Suche: Ticket-Texte werden beim Speichern in
  Embeddings umgewandelt, damit das MCP-Suchwerkzeug auch sinngemäße Treffer
  findet.
- **Schneller Chat** — optionaler Chat direkt im Dashboard gegen ein
  OpenWebUI-Modell, auf Wunsch mit angehängter Wissensbasis (nur im
  `real`-Modus verfügbar).
- **Markdown** — Konfiguration der Abschnitts-Überschriften der erzeugten
  Markdown-Datei.
- **Updates** — Update-Check konfigurieren und manuelle Ankündigungen verteilen.
- **Zugriff & Nutzer** — Dashboard-Sperre, Benutzer-Login und Rechte.
- **Sicherheit** — Passwort ändern.
- **Danger Zone** — destruktive Wartungsaktionen mit Passwort-Bestätigung.

Alle Tokens werden mit `SETTINGS_ENCRYPTION_KEY` AES-verschlüsselt in SQLite
abgelegt und in der UI nur maskiert dargestellt.

## Updates & Versionsbanner

Der Bot vergleicht die installierte Version (`package.json`) mit den GitHub-
Releases des konfigurierten Repositories und zeigt im Dashboard an, ob ein
Update verfügbar ist:

- **Banner** (oben, wegklickbar) bei neuen Major-/Minor-Releases, **Toast**
  (unten rechts) bei Patches und kleinen Änderungen. Der vollständige Changelog
  ist über den Banner direkt im Dashboard einsehbar.
- Ohne Webhook prüft der Bot automatisch **alle 6 Stunden** die GitHub-Releases-
  API (Ergebnis wird 30 Minuten zwischengespeichert, schont das Rate-Limit).
- Konfiguration im Admin-Tab **Updates**: Update-Check an/aus und das
  überwachte **Repository** (`owner/repo`). Forks tragen hier ihr eigenes
  Repository ein, um eigene Releases zu verfolgen.
- **Private Repositories**: Ohne Authentifizierung antwortet die GitHub-API
  mit 404. Im Admin-Tab lässt sich dafür ein **GitHub-Token** hinterlegen
  (Fine-grained Personal Access Token mit Lesezugriff auf „Contents" genügt);
  es wird wie alle Secrets verschlüsselt gespeichert. Alternativ funktionieren
  der Webhook und manuelle Ankündigungen auch ohne Token.
- **Manuelle Ankündigungen** verteilen Banner oder Toasts an alle Dashboards —
  ideal für Forks oder eigene Versionen ohne GitHub-Releases.
- Optionaler **GitHub-Webhook** unter `<Base-URL>/webhook/github` (Events
  `release` und `push`). Mit gesetztem Secret wird die Signatur im Header
  `X-Hub-Signature-256` (HMAC-SHA256 über den Rohbody) geprüft; ohne Secret
  werden Anfragen akzeptiert.

## Jira-Webhook einrichten

1. **Settings → System → Webhooks → Create a webhook**
2. URL: `https://<dein-host>/webhook/jira?secret=<JIRA_WEBHOOK_SECRET>`
   (Jira Cloud unterstützt keine Custom-Header — das Secret wandert in den
   Query-String, alternativ via Reverse-Proxy in den Header `X-KnowFlow-Secret`).
3. Events: **nur** `jira:issue_updated` aktivieren. Andere Events (Kommentare,
   Worklog, Attachments) werden ignoriert, damit KnowFlows eigene
   Status-Kommentare keine Endlosschleife auslösen.
4. JQL-Filter (empfohlen): `project in (KNOW, DOC, WIKI)`

Für lokale Entwicklung einen Tunnel verwenden:

```bash
cloudflared tunnel --url http://localhost:3000
# oder
ngrok http 3000
```

### Trigger-Logik

Der Webhook-Handler durchläuft:

1. Secret-Prüfung (`X-KnowFlow-Secret` oder `?secret=`), falls
   `JIRA_WEBHOOK_SECRET` gesetzt ist.
2. `webhookEvent` muss `jira:issue_updated` oder `jira:issue_generic` sein.
3. `changelog.items` muss eine Änderung mit `field === 'status'` enthalten.
   Der aktuelle `status.name` wird absichtlich **nicht** geprüft — sonst
   würde jeder neue Kommentar an einem „Erledigt"-Ticket die Pipeline
   erneut starten.
4. `projectKey` muss in den konfigurierten Projekten enthalten sein.
5. Neuer Status in `JIRA_DONE_STATUS` → Pipeline startet. Status in
   `JIRA_REWORK_STATUSES` → nur UI-Markierung, kein Pipeline-Lauf.

## Open-WebUI-Dummy-Modus

Im Default-Modus `OPENWEBUI_MODE=dummy` werden alle Open-WebUI-Aufrufe
lokal emuliert — ideal für Demos und Tests ohne echte Instanz:

- Datei-Upload schreibt nach `./data/openwebui-dummy/<uuid>.md` und legt
  einen Eintrag in `openwebui_dummy_files` an.
- Content-Update überschreibt Datei und DB-Eintrag.
- „Add to Knowledge" setzt nur das Flag `in_knowledge = 1`.
- Health-Check meldet immer `up` mit Label **Dummy-Modus**.

Die HTTP-Endpoints unter `/openwebui-dummy/api/v1/...` mimen das echte
Open-WebUI-Interface und lassen sich z. B. per `curl` ansprechen.

> Hinweis zu Open-WebUI-Bug **#23787**: nach
> `POST /api/v1/files/{id}/data/content/update` kann das Re-Index still
> fehlschlagen, der Endpoint liefert trotzdem 200.

## API & Socket.IO

REST-Endpoints (von der WebUI genutzt):

- `GET  /api/health` — Service-Status (server-seitig 30 min gecached).
- `GET  /api/tickets?page=&filter=&q=` — paginierte Ticket-Liste.
- `GET  /api/tickets/:id` — Details inkl. Markdown und Workflow-Run.
- `GET  /api/stats` — Dashboard-Zahlen, Throughput, Funnel.
- `GET  /api/activity?limit=` — Aktivitäts-Feed.
- `GET  /api/knowledge` — aktive Markdown-Dokumente.
- `POST /api/tickets/:id/retry` — Workflow erneut anstoßen.
- `POST /api/sync` — alle Fehler-Tickets erneut verarbeiten.

Admin-API unter `/api/admin/*` ist durch Session-Cookie geschützt.

Socket.IO-Events (Push an die WebUI):

- `workflow:update` — einzelne Pipeline-Schritte
- `activity:new` — neuer Event-Eintrag
- `ticket:status` — Statuswechsel eines Tickets
- `health:update` — Service-Health (reserviert)

## Webhook ohne echte Jira-Instanz simulieren

```bash
curl -X POST "http://localhost:3000/webhook/jira?secret=$JIRA_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
        "webhookEvent": "jira:issue_updated",
        "changelog": {
          "items": [
            { "field": "status", "fromString": "In Arbeit", "toString": "Erledigt" }
          ]
        },
        "issue": {
          "key": "KNOW-123",
          "fields": {
            "summary": "Beispiel-Ticket",
            "status":   { "name": "Erledigt" },
            "project":  { "key": "KNOW" },
            "priority": { "name": "Hoch" },
            "assignee": { "displayName": "M. Wagner" },
            "reporter": { "displayName": "S. Becker", "accountId": "abc-123" },
            "description": "Beispielbeschreibung..."
          }
        }
      }'
```

Im `real`-Jira-Modus wird die REST-API sofort kontaktiert — für reine
Trockenläufe entweder ein vorhandenes Test-Issue verwenden oder
`POST /api/tickets/:id/retry` an einem bereits in der DB gespeicherten
Ticket aufrufen.

## Projektstruktur

```
src/
  index.js               # Bootstrap: Express + Socket.IO
  config.js              # ENV-Parsing
  constants.js           # Workflow-Steps, Status-Werte, Socket-Events
  db/
    index.js             # SQLite-Connection (better-sqlite3)
    schema.js            # DDL für tickets, workflow_runs, events, settings, …
    queries.js           # DB-Operationen
  middleware/
    auth.js              # Session-Cookie-Auth für /api/admin
    rateLimit.js         # Rate-Limiter für sensible Endpoints
  routes/
    webhook.js           # POST /webhook/jira
    api.js               # Öffentliche /api/* Endpoints
    admin.js             # Geschützte /api/admin/* Endpoints
    debug.js             # /api/debug/* (nur bei UI_DEBUG=true)
    openwebuiDummy.js    # /openwebui-dummy/api/v1/*
    mcp.js               # MCP-Endpoints (/mcp/<id>)
    oauth.js             # OAuth 2.1 Authorization Server für MCP
    setup.js             # Setup-Assistent (Ersteinrichtung)
  services/
    jiraService.js       # Jira REST API + ADF-Kommentare
    markdownService.js   # Issue → Markdown
    openwebuiService.js  # Dummy + Real
    routingService.js    # Regel-Evaluation für Wissensbasen
    workflowService.js   # 3-Schritt-Pipeline
    settingsService.js   # DB-Settings (Seed, Get, Update)
    authService.js       # Passwort-Hashing, Login
    socketService.js     # Socket.IO-Wrapper
    debugState.js        # UI-Debug-Modus-Status
  utils/
    crypto.js            # AES-Verschlüsselung der Tokens
    mask.js              # Secret-Maskierung für Logs
public/                  # WebUI (Bootstrap + React via CDN, kein Build)
data/                    # Laufzeit-Daten (per .gitignore ausgeschlossen)
  knowflow.sqlite
  openwebui-dummy/<uuid>.md
```

## Troubleshooting

- **Webhook trifft nicht ein** — im Jira-Webhook-Setup prüfen, ob das Event
  `jira:issue_updated` aktiviert ist (nicht nur Kommentare/Worklog).
  Mit `WEBHOOK_DEBUG=true` zeigt der Server pro Request einen Diagnose-Block.
- **Endlosschleife / Jira 429** — heute durch Filter auf `webhookEvent` und
  Changelog-Prüfung verhindert. Falls dennoch beobachtet: alle Webhooks
  außer `jira:issue_updated` deaktivieren.
- **Health-Werte „eingefroren"** — gewollt. Server-seitig 30-min-Cache
  (`HEALTH_CACHE_TTL_MS` in `src/constants.js`), um Jira-Rate-Limits zu
  schonen.
- **OpenWebUI-Upload schlägt fehl** — im Dummy-Modus prüfen, ob
  `data/openwebui-dummy/` existiert und schreibbar ist. Im Real-Modus
  Token-Berechtigungen und Knowledge-ID prüfen.
- **Tokens nach Restart unbrauchbar** — `SETTINGS_ENCRYPTION_KEY` wurde
  geändert. Entweder den alten Key wiederherstellen oder Tokens im
  Dashboard neu eingeben.
