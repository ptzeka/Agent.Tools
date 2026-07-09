#!/usr/bin/env node
// Publishes a codeindex snapshot into codeindex/data/ (repo-first layout:
// codeindex/data/<owner>/<repo>/commits/<sha>/). codemcp serves that tree
// directly — there is no copy step into codemcp/data/ anymore.
//
// Usage:
//   node scripts/publish-codeindex.mjs [--root <path>] [--branch <name>]
//
// Defaults: --root = this repo's root, --branch = current branch of --root.
// The HEAD SHA's existing snapshot folder (if any) is removed first so a
// re-publish of the same commit never merges with stale chunks.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(repoRoot, 'codeindex', 'dist', 'cli.js');
const dataRoot = join(repoRoot, 'codeindex', 'data');

function step(message) {
  console.log(`\x1b[36m==> ${message}\x1b[0m`);
}

function fail(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

// Enumerate <owner>/<repo> subtrees under codeindex/data/.
function listRepoTrees() {
  if (!existsSync(dataRoot)) return [];
  const trees = [];
  for (const owner of readdirSync(dataRoot)) {
    const ownerDir = join(dataRoot, owner);
    if (!statSync(ownerDir).isDirectory()) continue;
    for (const repo of readdirSync(ownerDir)) {
      const repoDir = join(ownerDir, repo);
      if (statSync(repoDir).isDirectory()) trees.push({ label: `${owner}/${repo}`, dir: repoDir });
    }
  }
  return trees;
}

let root = repoRoot;
let branch = '';
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--root' || arg === '-r') root = resolve(argv[++i] ?? '');
  else if (arg === '--branch' || arg === '-b') branch = argv[++i] ?? '';
  else if (arg === '--help' || arg === '-h') {
    console.log('Usage: node scripts/publish-codeindex.mjs [--root <path>] [--branch <name>]');
    process.exit(0);
  } else fail(`Unknown option: ${arg}`);
}

if (!existsSync(cliPath)) {
  fail(`codeindex CLI not found at ${cliPath}. Run 'npm install && npm run build' first.`);
}
if (!existsSync(root)) fail(`Repository root not found: ${root}`);
if (!branch) branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD') || 'main';

step(`Repository root : ${root}`);
step(`Branch          : ${branch}`);

const headSha = git(root, 'rev-parse', 'HEAD');
if (headSha) {
  for (const tree of listRepoTrees()) {
    const snapshot = join(tree.dir, 'commits', headSha);
    if (existsSync(snapshot)) {
      step(`Removing existing snapshot for HEAD ${headSha} in ${tree.label}`);
      rmSync(snapshot, { recursive: true, force: true });
    }
  }
} else {
  console.warn('\x1b[33mCould not resolve HEAD SHA; skipping pre-clean.\x1b[0m');
}

step(`Publishing (backend=file, branch=${branch})`);
const publish = spawnSync(
  process.execPath,
  [cliPath, '--backend', 'file', '--branch', branch, '--root', root, 'publish'],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (publish.status !== 0) process.exit(publish.status ?? 1);

step('Snapshots now under codeindex/data/:');
for (const tree of listRepoTrees()) {
  const commitsDir = join(tree.dir, 'commits');
  const shas = existsSync(commitsDir) ? readdirSync(commitsDir) : [];
  console.log(`  ${tree.label}: ${shas.length} commit(s)${shas.length ? ` — ${shas.join(', ')}` : ''}`);
}
