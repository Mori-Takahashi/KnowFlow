'use strict';

/**
 * Sucht im Diff zwischen <base> und <head> nach offensichtlichen Secret-Mustern.
 * Exit 1 bei Fund, mit GitHub-Annotation pro Treffer.
 *
 * Usage: node check-secret-leak.js <baseSha> <headSha>
 */

const { execSync } = require('child_process');

const args = process.argv.slice(2);
const baseSha = args[0];
const headSha = args[1];

if (!baseSha || !headSha) {
  console.error('Usage: check-secret-leak.js <baseSha> <headSha>');
  process.exit(2);
}

const PATTERNS = [
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private Key Block', re: /-----BEGIN (RSA|EC|OPENSSH|PGP|DSA|PRIVATE) KEY-----/ },
  { name: 'Atlassian/Jira API Token', re: /ATATT[A-Za-z0-9_\-]{20,}/ },
  { name: 'GitHub Token', re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: 'OpenAI Key', re: /\bsk-[A-Za-z0-9]{30,}\b/ },
  { name: 'Anthropic Key', re: /\bsk-ant-[A-Za-z0-9\-_]{30,}\b/ },
  { name: 'Slack Token', re: /\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/ },
];

// Pro-Variable-Zuweisungen in committed .env-artigen Dateien
const ENV_ASSIGN_RE = /^(JIRA_API_TOKEN|JIRA_WEBHOOK_SECRET|OPENWEBUI_TOKEN)=.+$/;

function git(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

let diff;
try {
  diff = git(`git diff --unified=0 ${baseSha} ${headSha}`);
} catch (err) {
  console.error('git diff failed:', err.message);
  process.exit(2);
}

const findings = [];
let currentFile = null;
let currentLine = 0;

for (const line of diff.split(/\r?\n/)) {
  if (line.startsWith('+++ b/')) {
    currentFile = line.slice(6);
    continue;
  }
  if (line.startsWith('@@')) {
    const m = line.match(/\+(\d+)/);
    if (m) currentLine = Number.parseInt(m[1], 10) - 1;
    continue;
  }
  if (!line.startsWith('+') || line.startsWith('+++')) {
    if (line.startsWith(' ') || line.startsWith('-')) {
      // Kontextzeilen werden nicht hochgezählt im --unified=0-Modus, skip
    }
    continue;
  }
  currentLine += 1;
  const added = line.slice(1);

  if (!currentFile) continue;
  // Erlaubte / unkritische Pfade
  if (
    currentFile === '.env.example' ||
    currentFile.startsWith('.github/scripts/') ||
    currentFile.endsWith('.lock') ||
    currentFile === 'package-lock.json'
  ) {
    continue;
  }

  for (const { name, re } of PATTERNS) {
    if (re.test(added)) {
      findings.push({ file: currentFile, line: currentLine, kind: name, snippet: added.trim().slice(0, 120) });
    }
  }

  if (/(^|\/)\.env($|\.)/.test(currentFile) && ENV_ASSIGN_RE.test(added)) {
    findings.push({
      file: currentFile,
      line: currentLine,
      kind: 'Hardcoded secret in committed .env file',
      snippet: added.trim().slice(0, 120),
    });
  }
}

if (findings.length === 0) {
  console.log('OK: Keine offensichtlichen Secrets im Diff gefunden.');
  process.exit(0);
}

for (const f of findings) {
  console.error(`::error file=${f.file},line=${f.line}::Mögliches Secret (${f.kind}): ${f.snippet}`);
}
console.error(`\n${findings.length} mögliche(s) Secret(s) gefunden. Bitte vor Merge entfernen / rotieren.`);
process.exit(1);
