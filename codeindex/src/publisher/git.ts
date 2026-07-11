import { realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

export interface GitContext {
  commitSha: string;
  branch: string;
  isDirty: boolean;
  // owner/repo from remote.origin.url when available, else a stable id from rootDir's resolved path; never blank
  repository: string;
}

export function readGitContext(rootDir: string, fallbackBranch: string, override?: string): GitContext {
  if (override && override.trim().length > 0) {
    const base = readGitContextNoRepo(rootDir, fallbackBranch);
    return { ...base, repository: override.trim() };
  }
  const base = readGitContextNoRepo(rootDir, fallbackBranch);
  const repository = detectRepositoryName(rootDir) ?? repositoryIdFromResolvedPath(rootDir);
  return { ...base, repository };
}

function readGitContextNoRepo(rootDir: string, fallbackBranch: string): Omit<GitContext, 'repository'> {
  try {
    const commitSha = run('git rev-parse HEAD', rootDir);
    let branch = run('git rev-parse --abbrev-ref HEAD', rootDir);
    if (branch === 'HEAD' || branch === '') branch = fallbackBranch;
    const status = run('git status --porcelain', rootDir);
    const isDirty = status.length > 0;
    return { commitSha, branch, isDirty };
  } catch {
    const synthetic = `nogit-${Date.now().toString(16)}`;
    return { commitSha: synthetic, branch: fallbackBranch, isDirty: false };
  }
}

// stable repository key when git origin is missing: resolved absolute path, symlinks collapsed, / separators
export function repositoryIdFromResolvedPath(rootDir: string): string {
  const absolute = resolve(rootDir);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    canonical = absolute;
  }
  return canonical.replace(/\\/g, '/');
}

// owner/repo from remote.origin.url; null when no origin or git is unavailable,
// so the caller falls back to repositoryIdFromResolvedPath
export function detectRepositoryName(rootDir: string): string | null {
  let url: string;
  try {
    url = run('git config --get remote.origin.url', rootDir);
  } catch {
    return null;
  }
  if (!url) return null;
  return parseRepositoryFromOriginUrl(url);
}

// pulls the "owner/repo" tail out of an origin URL (common Git hosting shapes); exported for unit testing
export function parseRepositoryFromOriginUrl(url: string): string | null {
  const stripped = url.trim().replace(/\.git$/i, '');
  if (!stripped) return null;

  let pathPart: string;
  if (stripped.includes('://')) {
    const afterScheme = stripped.split('://')[1] ?? '';
    const slashIdx = afterScheme.indexOf('/');
    pathPart = slashIdx >= 0 ? afterScheme.slice(slashIdx + 1) : '';
  } else if (/^[^/]+@[^/]+:/.test(stripped)) {
    pathPart = stripped.split(':').slice(1).join(':');
  } else {
    pathPart = stripped;
  }

  const segments = pathPart.split('/').filter(s => s.length > 0 && s !== '_git');
  if (segments.length === 0) return null;
  if (segments.length === 1) return segments[0] ?? null;
  return segments.slice(-2).join('/');
}

// paths are relative to rootDir (git --relative / ls-files cwd semantics), posix separators.
// `touched` = every path whose indexed chunks are stale (modified, deleted, renamed either side,
// untracked); which of those still exist and are indexable is decided by the walker, not git
export interface ChangedFiles {
  touched: string[];
}

export function isAncestor(rootDir: string, ancestorSha: string, descendantSha: string): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${quoteSha(ancestorSha)} ${quoteSha(descendantSha)}`, {
      cwd: rootDir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

// everything different between the baseline commit and the working tree: committed, staged,
// unstaged (diff against <sha> with no second rev spans all three) plus untracked files.
// --no-renames keeps a rename as delete+add so both sides land in `touched`
export function changedFilesSince(rootDir: string, baselineSha: string): ChangedFiles {
  const diff = run(
    `git diff --name-status --no-renames --relative ${quoteSha(baselineSha)}`,
    rootDir,
  );
  const touched = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    touched.add(normalizeGitPath(line.slice(tab + 1)));
  }
  const untracked = run('git ls-files --others --exclude-standard', rootDir);
  for (const line of untracked.split(/\r?\n/)) {
    if (line.trim().length > 0) touched.add(normalizeGitPath(line));
  }
  return { touched: [...touched].sort() };
}

// git -z is not used, so quoted/escaped names arrive wrapped in double quotes
function normalizeGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

// shas reach here from commit.json dir names (validated on write) and git itself,
// but they still get injected into a shell command — allow only rev characters
function quoteSha(sha: string): string {
  if (!/^[A-Za-z0-9_\-]+$/.test(sha)) {
    throw new Error(`Invalid commit identifier: ${sha}`);
  }
  return sha;
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}
