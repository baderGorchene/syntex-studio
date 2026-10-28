// Builds the Next standalone server for the Electron shell (electron/main.cjs).
// 1. `next build` with every secret blanked, so no cloud key reaches the bundle (R26).
// 2. Copies public/ and .next/static into .next/standalone (standalone output leaves them out).
// 3. Deletes .env* files from the standalone tree and scans it for leaked secrets.
// 4. Checks that better-sqlite3 loads under Electron's Node.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const standalone = path.join(root, '.next', 'standalone');
const staticDir = path.join(root, '.next', 'static');
const require = createRequire(import.meta.url);

const SECRET_NAMES = ['DATABASE_URL', 'POSTGRES_URL', 'STORAGE_URL', 'CLERK_SECRET_KEY', 'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GCS_BUCKET_NAME', 'COLLAB_SECRET'];
const KEEP = new Set(['NODE_ENV', 'NEXT_TELEMETRY_DISABLED']);

function fail(message) {
  console.error(`desktop-prepare: ${message}`);
  process.exit(1);
}

// Every name assigned in a root .env* file (Next would load it), plus the known secrets and Clerk's public keys.
const envFiles = fs.readdirSync(root).filter((f) => f.startsWith('.env') && fs.statSync(path.join(root, f)).isFile());
const fileVars = new Map();
for (const file of envFiles) {
  for (const line of fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) fileVars.set(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
}
const blanked = new Set([...fileVars.keys(), ...SECRET_NAMES,
  ...Object.keys(process.env).filter((k) => k.startsWith('NEXT_PUBLIC_CLERK_'))]);
const env = { ...process.env };
for (const name of blanked) if (!KEEP.has(name)) env[name] = ''; // '' counts as set, so Next won't load it from .env*

const build = spawnSync(process.execPath, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'],
  { cwd: root, env, stdio: 'inherit' });
if (build.status !== 0) fail('next build failed.');

// File tracing follows the db/upload routes' fs calls into this checkout: the dev database, uploaded media,
// design notes and sources would otherwise ship in the installer.
for (const p of ['canvas.db', 'canvas.db-shm', 'canvas.db-wal', 'canvas.db-journal', '.backups', 'docs', 'src', 'collab-server', path.join('public', 'uploads')]) {
  fs.rmSync(path.join(standalone, p), { recursive: true, force: true });
}

fs.cpSync(path.join(root, 'public'), path.join(standalone, 'public'), {
  recursive: true,
  filter: (src) => !src.startsWith(path.join(root, 'public', 'uploads') + path.sep), // dev user media stays out
});
fs.cpSync(staticDir, path.join(standalone, '.next', 'static'), { recursive: true });

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// ponytail: plain string search over every output file. It catches `NAME=value`/`NAME:"value"` assignments,
// literal secret values from the local .env* files, and Clerk/Stripe keys in client chunks; an obfuscated or
// split secret would slip past. Upgrade to a real secret scanner (e.g. gitleaks) if the build grows more inputs.
// `NAME: "value"` / `NAME="value"` (inlined into code) or `NAME=value` at a line start (an env file).
const names = SECRET_NAMES.join('|');
const assigned = new RegExp(`\\b(${names})["'\`]?\\s*[:=]\\s*["'\`][^\\s"'\`]|^\\s*(${names})\\s*=\\s*[^\\s#]`, 'm');
const secretValues = SECRET_NAMES.map((n) => fileVars.get(n)).filter((v) => v && v.length >= 8);
const stripeOrClerkKey = /\b[ps]k_(?:test|live)_[A-Za-z0-9]{10,}/;
const leaks = [];
for (const file of [...walk(standalone), ...walk(staticDir)]) {
  if (path.basename(file).startsWith('.env')) {
    fs.rmSync(file);
    continue;
  }
  const text = fs.readFileSync(file, 'latin1');
  const rel = path.relative(root, file);
  const hit = assigned.exec(text);
  if (hit) leaks.push(`${rel}: ${hit[1] || hit[2]} is assigned a value`);
  if (secretValues.some((v) => text.includes(v))) leaks.push(`${rel}: contains a secret value from .env*`);
  if (file.endsWith('.js') && file.includes(`${path.sep}static${path.sep}`) && stripeOrClerkKey.test(text)) {
    leaks.push(`${rel}: client chunk contains a Clerk/Stripe key`);
  }
}
if (leaks.length) fail(`secrets found in the build output:\n  ${[...new Set(leaks)].join('\n  ')}`);

// better-sqlite3 ships N-API prebuilds, which load under Electron's Node as they are, so there is nothing to
// rebuild (and the traced copy has no sources to rebuild from). This fails loudly if that ever changes.
const electron = require('electron');
const sqlite = path.join(standalone, 'node_modules', 'better-sqlite3');
const load = spawnSync(electron, ['-e', `new (require(${JSON.stringify(sqlite)}))(':memory:').close()`],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
if (load.status !== 0) fail('better-sqlite3 does not load under Electron.');

console.log('desktop-prepare: standalone server ready, no secrets found.');
