'use strict';

/**
 * Stellt sicher, dass jede in src/ gelesene process.env.* Variable auch in
 * .env.example dokumentiert ist. Schlägt mit Exit-Code 1 fehl, falls Variablen
 * fehlen, und gibt GitHub Actions-Annotationen aus.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'src');
const ENV_FILE = path.join(ROOT, '.env.example');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith('.js')) out.push(full);
  }
  return out;
}

function collectEnvUsages() {
  const usages = new Map();
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  for (const file of walk(SRC_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      if (!usages.has(name)) usages.set(name, []);
      usages.get(name).push(path.relative(ROOT, file));
    }
  }
  return usages;
}

function collectDocumentedEnv() {
  const documented = new Set();
  const src = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    documented.add(trimmed.slice(0, eq).trim());
  }
  return documented;
}

// Diese Variablen sind systemseitig / dürfen fehlen.
const IGNORE = new Set(['NODE_ENV', 'DEBUG']);

function main() {
  const usages = collectEnvUsages();
  const documented = collectDocumentedEnv();

  const missing = [];
  for (const [name, files] of usages) {
    if (IGNORE.has(name)) continue;
    if (!documented.has(name)) missing.push({ name, files });
  }

  if (missing.length === 0) {
    console.log('OK: Alle in src/ verwendeten process.env.* sind in .env.example dokumentiert.');
    process.exit(0);
  }

  console.error('\n.env.example ist unvollständig:\n');
  for (const { name, files } of missing) {
    for (const file of files) {
      console.error(`::error file=${file}::Env-Variable ${name} wird im Code gelesen, fehlt aber in .env.example`);
    }
    console.error(`  - ${name} (verwendet in: ${files.join(', ')})`);
  }
  console.error(`\n${missing.length} fehlende Eintrag/Einträge in .env.example. Bitte ergänzen.`);
  process.exit(1);
}

main();
