# Security Policy

## Unterstützte Versionen

Sicherheitsupdates werden für den aktuellen Stand des `master`-Branches
bereitgestellt.

## Eine Sicherheitslücke melden

Bitte melde Sicherheitslücken **vertraulich** und nicht über öffentliche
GitHub-Issues.

- Nutze bevorzugt die GitHub-Funktion **"Report a vulnerability"** unter dem
  Reiter *Security* dieses Repositories (Private Vulnerability Reporting).
- Alternativ kannst du die Maintainer direkt kontaktieren.

Bitte gib so viele Details wie möglich an:

- betroffene Komponente / Datei
- Schritte zur Reproduktion
- mögliche Auswirkungen
- ggf. ein Proof-of-Concept

## Ablauf

- Wir bestätigen den Eingang in der Regel innerhalb von **5 Werktagen**.
- Wir halten dich über den Fortschritt der Behebung auf dem Laufenden.
- Bitte gib uns angemessene Zeit zur Behebung, bevor du Details
  veröffentlichst (Responsible Disclosure).

## Sicherheits-Hinweise zum Betrieb

- **Secrets**: `SETTINGS_ENCRYPTION_KEY` (Pflicht) verschlüsselt alle in der DB
  abgelegten Tokens (AES-256-GCM). Wird der Key geändert, sind bestehende Tokens
  unlesbar. Halte ihn geheim und beständig.
- **Reverse Proxy / HTTPS**: KnowFlow setzt `trust proxy` und liefert in
  Produktion (`NODE_ENV=production`) HSTS sowie `Secure`-Cookies aus. Betreibe
  den Dienst hinter einem TLS-terminierenden Proxy.
- **Login-Schutz**: Dashboard- und OAuth-Login sind ratenbegrenzt
  (Brute-Force-Schutz, fixes Zeitfenster pro IP).
- **Content-Security-Policy**: Da das Frontend Bootstrap/React/Babel von
  CDNs lädt, erlaubt die CSP `unsafe-eval` (für Babel-in-the-browser),
  `unsafe-inline` für Skripte (Babel re-injiziert die kompilierten `.jsx`
  als Inline-Skripte) sowie Inline-Styles. Die Skript-/Style-Quellen sind
  auf bekannte CDNs beschränkt.

### Bekannte Einschränkung: OAuth-Authorization-Codes

Der eingebaute OAuth-2.1-Server arbeitet **stateless** (HMAC-signierte Codes
und Tokens, kein serverseitiger Speicher). Authorization-Codes sind daher nicht
strikt einmalig verwendbar und könnten innerhalb ihres kurzen Gültigkeitsfensters
(5 Minuten) theoretisch erneut eingelöst werden. Das verpflichtende **PKCE
`S256`** schützt davor: Ohne den nur dem legitimen Client bekannten
`code_verifier` lässt sich ein abgefangener Code nicht einlösen.

Vielen Dank, dass du hilfst, KnowFlow sicher zu halten.
