#!/usr/bin/env node
// End-to-end setup verification — the scripted form of INSTALL.md §5.
// Checks, in dependency order, stopping at the first failure:
//   1. built    — dist entry points exist for codeindex/codemcp/memomcp
//   2. linked   — global @peritze/* links resolve to THIS checkout
//   3. indexed  — at least one repo-first snapshot under codeindex/data/
//   4. answers  — codemcp probe list_commits + memomcp probe recall succeed
// Live host checks (mcp__codemcp__* / mcp__memomcp__* after a restart) cannot
// be scripted from here; see INSTALL.md §5 step 5.
//
// Usage: npm run verify

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = join(repoRoot, 'codeindex', 'data');
let failures = 0;

function pass(message) {
  console.log(`\x1b[32mPASS\x1b[0m ${message}`);
}

function fail(message, hint) {
  failures += 1;
  console.error(`\x1b[31mFAIL\x1b[0m ${message}`);
  if (hint) console.error(`     fix: ${hint}`);
}

function bail() {
  console.error('\nStopped at the first failing step — it names the INSTALL.md step to redo.');
  process.exit(1);
}

// 1. built
const distEntries = [
  ['codeindex', join(repoRoot, 'codeindex', 'dist', 'cli.js')],
  ['codemcp', join(repoRoot, 'codemcp', 'dist', 'server.js')],
  ['memomcp', join(repoRoot, 'memomcp', 'dist', 'server.js')],
];
for (const [name, entry] of distEntries) {
  if (existsSync(entry)) pass(`built: ${name}`);
  else fail(`built: ${name} — missing ${entry}`, 'npm install && npm run build');
}
if (failures) bail();

// 2. linked — the global node_modules/@peritze/* links must resolve here.
const prefixResult = spawnSync('npm prefix -g', { encoding: 'utf8', shell: true });
const globalPrefix = prefixResult.stdout?.trim();
if (!globalPrefix) {
  fail('linked: could not resolve the global npm prefix', 'is npm on the PATH?');
} else {
  // Global node_modules lives directly under the prefix on Windows, under lib/ elsewhere.
  const globalModules = process.platform === 'win32'
    ? join(globalPrefix, 'node_modules')
    : join(globalPrefix, 'lib', 'node_modules');
  for (const name of ['codemcp', 'codeindex', 'memomcp']) {
    const linkPath = join(globalModules, '@peritze', name);
    try {
      const target = realpathSync(linkPath);
      const expected = realpathSync(join(repoRoot, name));
      if (target === expected) pass(`linked: ${name} -> ${target}`);
      else fail(`linked: ${name} resolves to ${target}, not this checkout`, 'npm run link:cli');
    } catch {
      fail(`linked: ${name} not linked globally (${linkPath})`, 'npm run link:cli');
    }
  }
}
if (failures) bail();

// 3. indexed — repo-first layout: codeindex/data/<owner>/<repo>/{schema_versions.json,commits/}
let snapshots = 0;
if (existsSync(dataRoot)) {
  for (const owner of readdirSync(dataRoot)) {
    const ownerDir = join(dataRoot, owner);
    if (!statSync(ownerDir).isDirectory()) continue;
    for (const repo of readdirSync(ownerDir)) {
      const repoDir = join(ownerDir, repo);
      const commitsDir = join(repoDir, 'commits');
      if (existsSync(join(repoDir, 'schema_versions.json')) && existsSync(commitsDir)) {
        const count = readdirSync(commitsDir).length;
        if (count > 0) {
          snapshots += count;
          pass(`indexed: ${owner}/${repo} — ${count} commit snapshot(s)`);
        }
      }
    }
  }
}
if (snapshots === 0) {
  fail('indexed: no snapshots under codeindex/data/', 'npm run index:publish');
  bail();
}

// 4. answers — run both servers' probe commands via their dist entry points.
function probe(name, entry, args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status === 0) pass(`answers: ${name} probe ${args[args.length - 2]}`);
  else {
    const detail = (result.stderr || result.stdout || 'no output').trim().split('\n').pop();
    fail(`answers: ${name} probe failed — ${detail}`);
  }
}
probe('codemcp', join(repoRoot, 'codemcp', 'dist', 'server.js'),
  ['--backend', 'file', 'probe', 'list_commits', '{}']);
probe('memomcp', join(repoRoot, 'memomcp', 'dist', 'server.js'),
  ['--backend', 'file', '--embed-provider', 'local', 'probe', 'recall', '{"query":"verify smoke test"}']);
if (failures) bail();

console.log('\n\x1b[32mAll checks passed.\x1b[0m Restart your MCP host and run the live checks in INSTALL.md §5 step 5.');
