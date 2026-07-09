#!/usr/bin/env node
// Clears indexed snapshots from codeindex/data/ (repo-first layout:
// codeindex/data/<owner>/<repo>/). codemcp serves this tree directly, so
// clearing it is the full reset — there is no codemcp/data/ copy anymore.
//
// Usage:
//   node scripts/clear-codeindex.mjs [--repo <owner/name>] [--schema] [--yes]
//
// Options:
//   --repo, -r    Clear only this <owner>/<name> subtree (default: all repos).
//   --schema, -s  Also delete schema_versions.json (forces re-migration on
//                 the next publish).
//   --yes, -y     Skip the confirmation prompt (required when not a TTY).

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = join(repoRoot, 'codeindex', 'data');

function step(message) {
  console.log(`\x1b[36m==> ${message}\x1b[0m`);
}

let onlyRepo = '';
let includeSchema = false;
let force = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--repo' || arg === '-r') onlyRepo = argv[++i] ?? '';
  else if (arg === '--schema' || arg === '-s') includeSchema = true;
  else if (arg === '--yes' || arg === '-y') force = true;
  else if (arg === '--help' || arg === '-h') {
    console.log('Usage: node scripts/clear-codeindex.mjs [--repo <owner/name>] [--schema] [--yes]');
    process.exit(0);
  } else {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  }
}

const targets = [];
if (existsSync(dataRoot)) {
  for (const owner of readdirSync(dataRoot)) {
    const ownerDir = join(dataRoot, owner);
    if (!statSync(ownerDir).isDirectory()) continue;
    for (const repo of readdirSync(ownerDir)) {
      const repoDir = join(ownerDir, repo);
      if (!statSync(repoDir).isDirectory()) continue;
      if (onlyRepo && `${owner}/${repo}` !== onlyRepo) continue;
      const commitsDir = join(repoDir, 'commits');
      if (existsSync(commitsDir)) {
        for (const sha of readdirSync(commitsDir)) targets.push(join(commitsDir, sha));
      }
      const schemaFile = join(repoDir, 'schema_versions.json');
      if (includeSchema && existsSync(schemaFile)) targets.push(schemaFile);
    }
  }
}

if (targets.length === 0) {
  step(`Nothing to clear${onlyRepo ? ` for ${onlyRepo}` : ''} under codeindex/data/.`);
  process.exit(0);
}

step('The following will be permanently removed:');
for (const target of targets) console.log(`  ${target}`);

if (!force) {
  if (!process.stdin.isTTY) {
    console.error('Not a TTY; pass --yes to confirm deletion non-interactively.');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Delete these ${targets.length} item(s)? [y/N] `)).trim();
  rl.close();
  if (!/^y(es)?$/i.test(answer)) {
    step('Aborted; nothing removed.');
    process.exit(0);
  }
}

for (const target of targets) rmSync(target, { recursive: true, force: true });
step(`Cleared ${targets.length} item(s). Run 'npm run index:publish' to rebuild the index.`);
