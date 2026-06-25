<!--
  Bitte folge dem Conventional-Commits-Schema im PR-Titel, z.B.:
    feat(webhook): Jira-Signaturvalidierung umsetzen
    fix(db): SQLite-Pfad bei relativem DATABASE_URL korrekt auflösen
    docs(readme): Setup-Schritte für lokales Cloudflare-Tunnel ergänzen
-->

## Was ändert dieser PR?
<!-- Kurze Beschreibung (1-3 Sätze): was wird geändert und warum. -->

## Verbundenes Jira-Ticket / Issue
<!-- z.B. KNOW-123 oder Closes #42 -->

## Art der Änderung
- [ ] feat — neues Feature
- [ ] fix — Bugfix
- [ ] refactor — keine Verhaltensänderung
- [ ] docs — nur Dokumentation
- [ ] chore / ci / build — Tooling, CI, Build
- [ ] breaking change — bricht bestehende Schnittstellen

## Checklist
- [ ] `npm ci` läuft lokal ohne Fehler
- [ ] App startet lokal mit Demo-`.env` (`OPENWEBUI_MODE=dummy`)
- [ ] Neue / geänderte `process.env.*`-Variablen sind in `.env.example` dokumentiert
- [ ] Keine echten Secrets, Tokens oder `.env`-Dateien commitet
- [ ] README / Praesentation.md bei Bedarf aktualisiert
- [ ] Docker-Build funktioniert (`docker compose build`), falls relevant

## Testanleitung
<!--
  Schritt-für-Schritt, wie ein Reviewer das Verhalten reproduziert.
  Mindestens: Setup-Befehl, Trigger (z.B. Webhook-Payload / UI-Aktion),
  erwartetes Ergebnis.
-->

## Screenshots / Logs (optional)
<!-- Bei UI-Änderungen Vorher/Nachher; bei Webhook-Änderungen Beispiel-Payload. -->
