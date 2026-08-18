# Jira mit OAuth 2.0 verbinden

KnowFlow kann sich bei Jira Cloud auf zwei Wegen anmelden:

- **OAuth 2.0 (3LO)** — empfohlen. Du meldest dich einmal bei Atlassian an, KnowFlow
  erneuert die Zugriffs-Tokens danach selbst.
- **API-Token** — der klassische Weg mit E-Mail und Token. Funktioniert weiterhin,
  das Token läuft aber ab und muss manuell erneuert werden.

Diese Seite beschreibt die einmalige Einrichtung von OAuth. Sie dauert wenige Minuten
und ist danach für alle Nutzer der Instanz erledigt.

| | OAuth 2.0 | API-Token |
|---|---|---|
| Anmeldung | Login bei Atlassian, ein Klick | Token kopieren und einfügen |
| Ablauf | Tokens werden automatisch erneuert | Token läuft ab, manuelles Nachziehen |
| Rechte | Nur die angefragten Scopes | Alle Rechte des Benutzerkontos |
| Entziehen | Jederzeit im Atlassian-Konto | Token muss gelöscht werden |

> **Voraussetzung:** Jira **Cloud** (`*.atlassian.net`). Für Jira Server/Data Center
> gibt es kein 3LO — dort bleibt die Anmeldung per API-Token.

## Schritt 1 — Atlassian-App anlegen

1. Öffne die [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/).
2. **Create** → **OAuth 2.0 integration** wählen.
3. Einen Namen vergeben (z. B. „KnowFlow"), die Bedingungen bestätigen und **Create** klicken.

## Schritt 2 — Berechtigungen (Scopes) setzen

1. In der App auf **Permissions** gehen.
2. Bei **Jira API** auf **Add** und anschließend auf **Configure** klicken.
3. Diese Scopes aktivieren:
   - `read:jira-work` — Tickets, Felder und Anhänge lesen
   - `write:jira-work` — Kommentare schreiben und Status wechseln

Den Scope `offline_access` musst du nicht anhaken — KnowFlow fordert ihn beim Login
selbst an. Er sorgt für das Refresh-Token, mit dem die Verbindung dauerhaft hält.

## Schritt 3 — Rücksprung-Adresse eintragen

1. In der App auf **Authorization** gehen.
2. Bei **OAuth 2.0 (3LO)** auf **Configure** klicken.
3. Als **Callback URL** die öffentliche Adresse deiner KnowFlow-Instanz eintragen,
   ergänzt um `/api/jira/oauth/callback`:

   ```
   https://knowflow.example.com/api/jira/oauth/callback
   ```

   Lokal entsprechend:

   ```
   http://localhost:3000/api/jira/oauth/callback
   ```

Die Adresse muss **exakt** mit `PUBLIC_BASE_URL` aus deiner `.env` übereinstimmen —
inklusive `http`/`https` und ohne abschließenden Schrägstrich. Weicht sie ab, bricht
Atlassian die Anmeldung mit einer Redirect-Fehlermeldung ab.

## Schritt 4 — Zugangsdaten in die `.env` eintragen

1. In der App auf **Settings** gehen und dort **Client ID** und **Secret** kopieren.
2. Beides in die `.env` von KnowFlow eintragen:

   ```bash
   JIRA_OAUTH_CLIENT_ID=deine-client-id
   JIRA_OAUTH_CLIENT_SECRET=dein-client-secret
   ```

3. KnowFlow neu starten:

   ```bash
   npm start
   ```

Beim Start zeigt die Konsole in der Zeile `Jira Auth`, ob OAuth einsatzbereit ist.

## Schritt 5 — Verbinden

**Bei der Ersteinrichtung:** Im Schritt „Jira-Verbindung" ist **OAuth 2.0** vorausgewählt.
Ein Klick auf **Mit Jira anmelden** führt zu Atlassian; nach der Bestätigung landest du
wieder im Assistenten und die Verbindung ist eingetragen. Projekt-Schlüssel und Status
füllst du wie gewohnt aus.

**Später:** **Admin** → **Allgemein** → **Jira-Verbindung**. Dort zeigt eine Statuskarte
die aktive Anmeldemethode und bietet **Mit Jira anmelden** bzw. **Verbindung trennen** an.

Ist keine OAuth-App hinterlegt, bleibt der Button deaktiviert und der Weg über das
API-Token steht unverändert zur Verfügung.

## Was KnowFlow speichert

| Wert | Zweck |
|---|---|
| Access-Token | Zugriff auf die Jira-API (Laufzeit 1 Stunde) |
| Refresh-Token | Erneuert das Access-Token automatisch |
| Cloud-ID | Adressiert deine Jira-Instanz über `api.atlassian.com` |
| Site-URL, Kontoname | Anzeige im Dashboard und Links in Kommentaren |

Beide Tokens liegen — wie alle Secrets — mit `SETTINGS_ENCRYPTION_KEY` verschlüsselt in
SQLite. **Verbindung trennen** löscht sie; ein zuvor hinterlegtes API-Token bleibt als
Rückfalloption erhalten.

## Troubleshooting

**„Jira OAuth ist nicht eingerichtet"**
`JIRA_OAUTH_CLIENT_ID` oder `JIRA_OAUTH_CLIENT_SECRET` fehlen bzw. wurden nach dem
Eintragen nicht neu geladen. Werte prüfen und KnowFlow neu starten.

**Atlassian meldet einen ungültigen Redirect**
Die Callback-URL in der Developer Console weicht von `PUBLIC_BASE_URL` ab. Beide müssen
zeichengenau übereinstimmen.

**„Die Jira-Anmeldung ist abgelaufen"**
Zwischen Start und Rücksprung lagen mehr als 10 Minuten, oder der Server wurde
neu gestartet. Einfach erneut auf **Mit Jira anmelden** klicken.

**„Für dieses Atlassian-Konto ist keine Jira-Cloud-Instanz freigegeben"**
Das angemeldete Konto hat keinen Zugriff auf eine Jira-Site, oder die App wurde ohne
Jira-Scopes angelegt. Schritt 2 prüfen und mit dem passenden Konto anmelden.

**„Jira-OAuth-Token ist abgelaufen und es liegt kein Refresh-Token vor"**
Die Verbindung wurde ohne `offline_access` hergestellt (z. B. eine sehr alte
Autorisierung). Einmal **Verbindung trennen** und neu anmelden.

## Weiterführend

- [Atlassian: OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)
- [Jira Cloud REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
