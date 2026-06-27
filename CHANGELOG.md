# Changelog

Alle nennenswerten Änderungen an diesem Projekt werden in dieser Datei
dokumentiert.

Das Format orientiert sich an
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/) und das Projekt folgt
[Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

## [1.3.1] - 2026-06-27

### Security

- **CWE-306 — Fehlende Authentifizierung an `/openwebui-dummy`-Endpunkten behoben
  (GHSA-5677-gpw3-5f8f)**: Die drei schreibenden Dummy-Endpunkte
  (`POST /openwebui-dummy/api/v1/files/`,
  `POST /openwebui-dummy/api/v1/files/:id/data/content/update`,
  `POST /openwebui-dummy/api/v1/knowledge/:knowledgeId/file/add`) wurden bisher
  unbedingt gemountet und waren ohne Authentifizierung erreichbar. Ein Angreifer
  konnte mit einem gültigen CSRF-Token (öffentlich abrufbar) beliebige Datenbankzeilen
  einfügen, Dateiinhalte überschreiben und den `in_knowledge`-Status beliebiger
  Einträge setzen — ohne gültige Session.
  Der Router wird ab sofort **nur noch im Dummy-Modus gemountet** und ist zusätzlich
  durch das `requireSession`-Middleware geschützt: unauthentifizierte Anfragen
  erhalten `401`. Instanzen, die im `real`-Modus betrieben werden, sind vollständig
  abgeschirmt, da der Router dort gar nicht registriert wird. Gemeldet von [frosch1q](https://github.com/frosch1q) und 
  [Lyonel Berzen](https://github.com/Mori-Takahashi) (2026-06-27).

## [1.3.0] - 2026-06-26

### Added

- **Lokaler Embedding-Provider (semantische Suche ohne externen Dienst)**: Neuer
  RAG-Modus **„Lokal (im Server)"**, der Embeddings direkt im KnowFlow-Prozess
  per [Transformers.js](https://github.com/huggingface/transformers.js) (ONNX
  Runtime) berechnet — kein Python, kein zweiter Dienst und keine GPU
  erforderlich. Damit schließt sich die Lücke zwischen der reinen Stichwortsuche
  (`off`), Cloud-Embeddings (`openai`) und einem dedizierten lokalen Server
  (`ollama`): das „Zwischending" für mittelstarke Server. Das Modell
  (Standard `Xenova/multilingual-e5-small`, mehrsprachig inkl. Deutsch) wird beim
  ersten Einsatz einmalig heruntergeladen und zwischengespeichert; die Pipeline
  bleibt im Speicher und wird nur bei einem Modellwechsel neu geladen. Im Admin-Tab
  **RAG** als eigener Modus auswählbar, inklusive frei wählbarem Modellnamen. Wie
  bei jedem Provider-Wechsel werden bestehende Vektoren über den Modell-Tag
  invalidiert — nach dem Umschalten einmal **„Alle neu indizieren"** ausführen.
  Neuer netzwerkfreier Test-Block für den Embedding-Service (`npm test`).

## [1.1.0] - 2026-06-24

## What's Changed

- feat(routing): Ignorieren-Filter für Routing-Regeln by [@Mori-Takahashi](https://github.com/Mori-Takahashi) in [#77](https://github.com/Mori-Takahashi/KnowFlow/pull/77)
- feat(mcp): Fehler-Rückmeldung aus dem Chat zurück nach Jira by [@Mori-Takahashi](https://github.com/Mori-Takahashi) in [#78](https://github.com/Mori-Takahashi/KnowFlow/pull/78)
**Full Changelog**: [1.0.1...1.1.0](https://github.com/Mori-Takahashi/KnowFlow/compare/1.0.1...1.1.0)

### Added

- **Fehler-Rückmeldung aus dem Chat zurück nach Jira (MCP)**: Neues, schreibendes
  MCP-Werkzeug `report_inaccuracy`. Bemerkt ein Nutzer in einer Antwort eine
  Kommentar an das zugehörige Jira-Ticket (mit `@mention` des Reporters und Link
  aufs Dashboard). Ist ein „Wird überarbeitet"-Status (`reworkStatuses`)
  konfiguriert, wird das Ticket zusätzlich automatisch dorthin verschoben — das
  löst dank des Webhook-Changelog-Filters keine erneute Pipeline aus. Pro
  MCP-Verbindung im Admin-Tab **MCP-Verbindungen** aktivierbar (Standard AUS); nur
  dann taucht das Werkzeug auf. Die Aktion erscheint im Aktivitäts-Feed (Quelle
  `MCP`). Neue Test-Suite via `node --test` (`npm test`).

## [1.0.0] - 2026-06-23

### Added

- **Zugriffssteuerung, Benutzerrolle & MCP-Authentifizierung**: Drei neue,
  optional aktivierbare Schutzmechanismen, gebündelt im Admin-Tab
  „Zugriff & Nutzer":
  - **MCP-Authentifizierung pro Verbindung**: Jede der sechs MCP-Verbindungen
    kann einzeln auf „Authentifizierung erforderlich" gestellt werden. Zwei Wege:
    - **OAuth 2.1**: KnowFlow ist selbst ein OAuth-Authorization-Server
      (Protected-Resource- und AS-Metadata unter `/.well-known/*`, Dynamic Client
      Registration, `/oauth/authorize` mit KnowFlow-Login-Seite, `/oauth/token`,
      Authorization Code + PKCE `S256`). Damit funktioniert der claude.ai-„Custom
      Connector" mit reiner URL-Eingabe; der `POST /mcp/<id>`-Endpunkt antwortet
      bei fehlender Auth mit `401` inkl. `WWW-Authenticate`-Pointer.
    - **Statisches Bearer-Token**: pro Verbindung erzeugbar (Header
      `Authorization: Bearer <token>` oder `x-mcp-token`) für Clients mit eigenem
      Header (z. B. `mcp-remote`/API). Im Dashboard anzeigen, kopieren, neu erzeugen.
  - **Benutzer-Login (Rollen)**: Neben dem Admin lässt sich ein separates
    Benutzer-Passwort vergeben. Angemeldete Benutzer sehen das Dashboard und –
    je nach Freigabe – ausgewählte Einstellungen.
  - **Granulare Benutzer-Rechte**: Der Admin legt fest, ob Benutzer die
    Einstellungen einsehen, bearbeiten und/oder den Ticket-Lebenszyklus
    (veraltet/löschen/reaktivieren) ändern dürfen.
  - **Dashboard-Sperre**: Optional ist das gesamte Dashboard inkl. Live-Daten
    (REST-API und Socket.IO) erst nach Anmeldung sichtbar, damit nicht jeder
    einsehen kann, welche Daten fließen. Ein Vollbild-Login ersetzt dann das
    Dashboard bis zur Anmeldung.
- **MCP-Bilderanzeige**: Die MCP-Verbindungen können Bilder eines Tickets nun
  direkt anzeigen. Das neue Werkzeug `show_images` liefert die Bild-Anhänge
  eines Wissenseintrags inline (als Bildinhalt) zusammen mit ihren öffentlichen
  Links. `list_attachments` gibt zusätzlich für jeden Anhang einen direkten
  Download-Link aus und markiert Bilder.
- **Versionsbanner & Update-Check**: Das Dashboard zeigt die installierte und
  die neueste verfügbare Version an. Neue Releases (Major/Minor) erscheinen als
  wegklickbarer Banner, kleine Änderungen und Patches als kurzer Toast. Der
  vollständige Changelog (Releases samt Beschreibung und manuelle Ankündigungen)
  ist direkt im Dashboard einsehbar. Konfiguration im Admin-Tab „Updates": eigenes
  Repository für Forks, optionaler GitHub-Webhook unter `/webhook/github` (mit
  HMAC-Secret über `X-Hub-Signature-256`), optionales GitHub-Token für private
  Repositories und manuelle Ankündigungen, um eigene Versionen ohne
  GitHub-Releases an alle Dashboards zu verteilen. Ohne Webhook prüft der Bot
  automatisch alle 6 Stunden die GitHub-Releases.
- **Setup-Assistent für die Ersteinrichtung**: Startet der Bot zum ersten Mal
  ohne `ADMIN_PASSWORD`, führt ein animierter Schritt-für-Schritt-Assistent im
  Browser durch die Grundeinrichtung (Admin-Passwort, optional Jira-Verbindung,
  OpenWebUI-Modus und erste Wissensbasis). Nach Abschluss ist man automatisch
  angemeldet. Bestehende Installationen sehen den Assistenten nicht; die
  zugehörigen Endpunkte unter `/api/setup` sperren sich nach Abschluss selbst.
- **Danger Zone** im Admin-Dashboard: Webhook-Verarbeitung pausieren bzw.
  aktivieren (reversibel, ohne Passwort), Aktivitäts-Feed leeren, alle Tickets
  samt zugehörigem Wissen und lokalen Anhängen löschen, die Konfiguration auf
  den Auslieferungszustand zurücksetzen (Admin-Passwort bleibt erhalten) und den
  Dienst beenden bzw. neu starten. Die destruktiven Aktionen werden jeweils per
  Admin-Passwort bestätigt.
- OSS-Readiness-Dateien: `LICENSE` (ISC), `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md` und dieses `CHANGELOG.md`.
- Korrektes `repository`-, `homepage`-, `bugs`- und `engines`-Feld (Node ≥ 20)
  in `package.json`.
- Jira-Webhook-Verarbeitung: Tickets werden zu Markdown konvertiert und in die
  Open-WebUI-Wissensdatenbank übernommen.
- Live-Dashboard (Pipeline-Funnel, Throughput, Ticketliste, Aktivitäts-Feed via
  Socket.IO).
- Anhänge, MCP-Server mit 6 Verbindungen, MCP-Tab und Ticket-Soft-Delete.

### Security

- **Brute-Force-Schutz**: Dashboard-Login (`/api/admin/login`) und OAuth-Login
  (`POST /oauth/authorize`) sind pro IP ratenbegrenzt (fixes Zeitfenster).
- **Security-Header** auf allen Antworten: `Content-Security-Policy`,
  `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy` sowie `Strict-Transport-Security` in Produktion.
- **`trust proxy`** aktiviert, damit Client-IP, `Secure`-Cookies und das
  Rate-Limiting hinter einem TLS-terminierenden Reverse-Proxy korrekt greifen.
- Globaler Error-Handler gibt in Produktion keine internen Fehlerdetails mehr an
  den Client aus (vollständiger Stack nur noch serverseitig im Log).

### Fixed

- `PR Title Lint` schlägt nicht mehr bei Dependabot-PRs fehl
  ("Resource not accessible by integration"); der Lint wird für Dependabot
  übersprungen.

### Removed

- Nicht mehr benötigte Projekt-Artefakte: statisches `Mockup/`-Verzeichnis
  (durch `public/` abgelöst) und `Umsetzung.pdf`.
