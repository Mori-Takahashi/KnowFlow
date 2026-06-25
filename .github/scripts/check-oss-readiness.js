'use strict';

/**
 * Prüft, ob die für ein Open-Source-Projekt empfohlenen Dateien vorhanden sind.
 * Fehlende Pflicht-Dateien (LICENSE, README) -> Fehler. Empfohlene fehlen ->
 * Warnung (notice), Workflow bleibt grün.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const REQUIRED = [
  {
    name: 'LICENSE',
    candidates: ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING'],
    why: 'Ohne LICENSE-Datei ist unklar, unter welchen Bedingungen der Code genutzt werden darf.',
  },
  {
    name: 'README',
    candidates: ['README.md', 'README'],
    why: 'README erklärt Setup, Nutzung und Architektur.',
  },
];

const RECOMMENDED = [
  {
    name: 'CONTRIBUTING',
    candidates: ['CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md'],
    why: 'Beschreibt, wie Beiträge eingereicht werden (Branch-Konvention, Commit-Style, Tests).',
  },
  {
    name: 'SECURITY',
    candidates: ['SECURITY.md', '.github/SECURITY.md'],
    why: 'Erklärt, wie Sicherheitslücken privat gemeldet werden.',
  },
  {
    name: 'CODE_OF_CONDUCT',
    candidates: ['CODE_OF_CONDUCT.md', '.github/CODE_OF_CONDUCT.md'],
    why: 'Verhaltenskodex für die Community.',
  },
  {
    name: 'CHANGELOG',
    candidates: ['CHANGELOG.md', 'docs/CHANGELOG.md'],
    why: 'Versionierte Übersicht der Änderungen.',
  },
  {
    name: 'PULL_REQUEST_TEMPLATE',
    candidates: ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md'],
    why: 'Strukturiert PR-Beschreibungen.',
  },
  {
    name: 'CODEOWNERS',
    candidates: ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'],
    why: 'Definiert Review-Verantwortliche pro Pfad.',
  },
  {
    name: 'dependabot.yml',
    candidates: ['.github/dependabot.yml'],
    why: 'Automatische Dependency-Updates.',
  },
  {
    name: '.gitignore',
    candidates: ['.gitignore'],
    why: 'Verhindert Commits von node_modules, .env etc.',
  },
];

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function findFirst(candidates) {
  return candidates.find(exists) || null;
}

let hardFail = 0;
const missingRecommended = [];

for (const item of REQUIRED) {
  const found = findFirst(item.candidates);
  if (!found) {
    console.error(`::error::Pflicht-Datei fehlt: ${item.name}. ${item.why} Erwartet einen von: ${item.candidates.join(', ')}`);
    hardFail++;
  } else {
    console.log(`OK (required): ${item.name} -> ${found}`);
  }
}

for (const item of RECOMMENDED) {
  const found = findFirst(item.candidates);
  if (!found) {
    console.log(`::warning::Empfohlene Datei fehlt: ${item.name}. ${item.why} Erwartet einen von: ${item.candidates.join(', ')}`);
    missingRecommended.push(item.name);
  } else {
    console.log(`OK (recommended): ${item.name} -> ${found}`);
  }
}

// package.json sollte license, repository, description haben
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const need = ['name', 'version', 'description', 'license', 'repository'];
  for (const key of need) {
    if (!pkg[key]) {
      console.log(`::warning::package.json: Feld "${key}" fehlt oder ist leer.`);
    }
  }
  if (pkg.license === 'ISC' || pkg.license === 'UNLICENSED') {
    console.log(`::warning::package.json.license ist "${pkg.license}" — für Open Source bewusst wählen (z.B. MIT, Apache-2.0).`);
  }
} catch (err) {
  console.error(`::error::package.json konnte nicht gelesen werden: ${err.message}`);
  hardFail++;
}

if (hardFail > 0) {
  console.error(`\n${hardFail} Pflicht-Check(s) fehlgeschlagen.`);
  process.exit(1);
}

if (missingRecommended.length > 0) {
  console.log(`\nHinweis: ${missingRecommended.length} empfohlene Datei(en) fehlen, sind aber nicht blockierend.`);
}
console.log('OSS-Readiness: alle Pflicht-Dateien vorhanden.');
