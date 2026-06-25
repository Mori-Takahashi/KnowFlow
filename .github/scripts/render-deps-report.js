'use strict';

/**
 * Wandelt die Ausgaben von `npm outdated --json` und `npm audit --json` in einen
 * kompakten Markdown-Report um, der als PR-Kommentar gepostet wird.
 *
 * Usage: node render-deps-report.js <outdated.json> <audit.json>
 */

const fs = require('fs');

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const outdated = readJson(process.argv[2] || 'outdated.json');
const audit = readJson(process.argv[3] || 'audit.json');

function classify(current, latest) {
  if (!current || !latest) return 'unknown';
  const [cM, cm, cp] = current.replace(/^[^\d]*/, '').split('.').map(Number);
  const [lM, lm, lp] = latest.replace(/^[^\d]*/, '').split('.').map(Number);
  if (lM > cM) return 'major';
  if (lM === cM && lm > cm) return 'minor';
  if (lM === cM && lm === cm && lp > cp) return 'patch';
  return 'same';
}

const lines = [];
lines.push('## Dependency-Report');
lines.push('');
lines.push('Automatisch generiert bei jedem Push auf diesen PR.');
lines.push('');

// ---- Outdated ----
const entries = Object.entries(outdated);
if (entries.length === 0) {
  lines.push('### Outdated Dependencies');
  lines.push('');
  lines.push('Alle Dependencies sind aktuell.');
} else {
  const rows = entries.map(([name, info]) => {
    const kind = classify(info.current, info.latest);
    const badge =
      kind === 'major' ? 'major'
      : kind === 'minor' ? 'minor'
      : kind === 'patch' ? 'patch'
      : '-';
    return {
      name,
      current: info.current || '-',
      wanted: info.wanted || '-',
      latest: info.latest || '-',
      type: info.type || '-',
      kind: badge,
    };
  });

  const counts = rows.reduce((acc, r) => {
    acc[r.kind] = (acc[r.kind] || 0) + 1;
    return acc;
  }, {});

  lines.push('### Outdated Dependencies');
  lines.push('');
  lines.push(
    `${rows.length} Pakete veraltet — `
    + `major: ${counts.major || 0}, minor: ${counts.minor || 0}, patch: ${counts.patch || 0}.`,
  );
  lines.push('');
  lines.push('| Paket | Current | Wanted | Latest | Update | Scope |');
  lines.push('|---|---|---|---|---|---|');
  // Sortiere: major zuerst, dann minor, dann patch
  const order = { major: 0, minor: 1, patch: 2, same: 3, unknown: 4 };
  rows.sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
  for (const r of rows) {
    lines.push(`| \`${r.name}\` | ${r.current} | ${r.wanted} | **${r.latest}** | ${r.kind} | ${r.type} |`);
  }
  lines.push('');
  lines.push('> Update mit `npm update <paket>` (semver-kompatibel) oder gezielt `npm install <paket>@latest` (kann Breaking Changes enthalten).');
}

lines.push('');

// ---- Audit ----
lines.push('### Security Audit');
lines.push('');
const meta = audit && audit.metadata && audit.metadata.vulnerabilities;
if (!meta) {
  lines.push('Audit-Daten konnten nicht gelesen werden.');
} else {
  const total = (meta.info || 0) + (meta.low || 0) + (meta.moderate || 0) + (meta.high || 0) + (meta.critical || 0);
  if (total === 0) {
    lines.push('Keine bekannten Schwachstellen.');
  } else {
    lines.push(
      `${total} Schwachstellen — `
      + `critical: ${meta.critical || 0}, high: ${meta.high || 0}, `
      + `moderate: ${meta.moderate || 0}, low: ${meta.low || 0}, info: ${meta.info || 0}.`,
    );
    lines.push('');
    lines.push('Details: `npm audit` lokal ausführen. Fix-Versuch: `npm audit fix` (semver-kompatibel) bzw. `npm audit fix --force` (kann Breaking Changes enthalten).');
  }
}

lines.push('');
lines.push('<sub>Quelle: `npm outdated --json` + `npm audit --json` auf dem PR-HEAD.</sub>');

process.stdout.write(lines.join('\n') + '\n');
