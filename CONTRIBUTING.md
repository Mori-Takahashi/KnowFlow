# Contributing zu KnowFlow

Danke, dass du zu KnowFlow beitragen möchtest! Dieses Dokument beschreibt die
Konventionen für Branches, Commits, Pull Requests und Tests.

## Voraussetzungen

- Node.js 20+
- npm

```bash
npm ci
cp .env.example .env   # Werte anpassen
npm run dev
```

## Branch-Konvention

- Entwickle nie direkt auf `master`.
- Erstelle einen Feature-Branch, z. B. `feat/webhook-signatur` oder
  `fix/sqlite-pfad`.

## Commit- und PR-Titel (Conventional Commits)

Sowohl Commits als auch PR-Titel folgen den
[Conventional Commits](https://www.conventionalcommits.org/). Erlaubte Typen:

`feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `ci`, `build`,
`style`, `revert`

Beispiele:

```
feat(webhook): Jira-Signatur prüfen
fix(db): SQLite-Pfad bei relativem DATABASE_URL korrekt auflösen
```

Der Text nach dem Typ muss mit einem Buchstaben oder einer Zahl beginnen.

## Pull Requests

1. Stelle sicher, dass die CI grün ist (`PR Validate`, `PR Title Lint` etc.).
2. Halte PRs klein und fokussiert – große PRs (>1000 Zeilen) bitte aufteilen.
3. Fülle die PR-Vorlage aus.
4. Dokumentiere neue Environment-Variablen in `.env.example` – die CI prüft
   die Konsistenz automatisch.

## Tests & Checks lokal ausführen

```bash
# Syntax-Check aller Quelldateien
find src -type f -name '*.js' -exec node --check {} \;

# OSS-Readiness und .env-Konsistenz
node .github/scripts/check-oss-readiness.js
node .github/scripts/check-env-consistency.js
```

## Sicherheitslücken

Sicherheitsrelevante Probleme bitte **nicht** über öffentliche Issues melden,
sondern wie in [SECURITY.md](SECURITY.md) beschrieben.
