// Rewrites cross-package import edges from `external:<pkg>#Symbol` to the
// defining file's entity id (`<dir>/src/....ts#Symbol`) when <pkg> is a
// workspace member of the indexed repo. Parsers stay lexical (they resolve on
// content alone); this pass runs in the publisher, which knows the repo root
// and every indexed chunk, so it can join package names to source files.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeEdge, RawChunk } from '../types.js';
import { symbolId } from '../indexer/parsers/entityIds.js';

// the only chunk fields symbol resolution reads — the incremental publisher feeds
// this from stored chunk summaries (no content on hand), the full path from RawChunk
export type SymbolChunk = Pick<RawChunk, 'path' | 'symbol' | 'parentSymbol'>;

export interface WorkspacePackage {
  /** package.json "name", e.g. "@peritze/vectorstore" */
  name: string;
  /** repo-relative posix dir of the workspace member, e.g. "vectorstore" */
  dir: string;
}

// Reads <root>/package.json "workspaces" and each member's package name.
// Supports literal dirs and single-level `<dir>/*` globs (npm's common forms).
// Repos without workspaces yield [] and the rewrite becomes a no-op.
export function discoverWorkspacePackages(rootDir: string): WorkspacePackage[] {
  const rootManifest = readManifest(join(rootDir, 'package.json'));
  const patterns: string[] = Array.isArray(rootManifest?.workspaces) ? rootManifest.workspaces : [];
  const packages: WorkspacePackage[] = [];
  for (const pattern of patterns) {
    for (const dir of expandPattern(rootDir, pattern)) {
      const manifest = readManifest(join(rootDir, dir, 'package.json'));
      if (typeof manifest?.name === 'string') packages.push({ name: manifest.name, dir });
    }
  }
  return packages;
}

function readManifest(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function expandPattern(rootDir: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized.endsWith('/*')) {
    return isDirectory(join(rootDir, normalized)) ? [normalized] : [];
  }
  const parent = normalized.slice(0, -2);
  const parentAbs = join(rootDir, parent);
  if (!isDirectory(parentAbs)) return [];
  return readdirSync(parentAbs)
    .filter(entry => isDirectory(join(parentAbs, entry)))
    .map(entry => (parent ? `${parent}/${entry}` : entry));
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

// Pure rewrite: `external:<pkgName>[/subpath]#Symbol` -> `<definingPath>#Symbol`
// when exactly one indexed chunk in that package defines the symbol at top
// level. No match (or an ambiguous one) leaves the edge external rather than
// guessing a wrong definition site.
export function resolveWorkspaceEdges(
  edges: CodeEdge[],
  chunks: SymbolChunk[],
  packages: WorkspacePackage[],
): { edges: CodeEdge[]; resolvedCount: number } {
  if (packages.length === 0) return { edges, resolvedCount: 0 };

  const symbolPathsByPackage = indexTopLevelSymbols(chunks, packages);
  let resolvedCount = 0;
  const rewritten = edges.map(edge => {
    const target = parseExternalTarget(edge.to, packages);
    if (!target?.symbol) return edge;
    const paths = symbolPathsByPackage.get(target.pkg.name)?.get(target.symbol);
    if (!paths || paths.size !== 1) return edge;
    resolvedCount += 1;
    return { ...edge, to: symbolId([...paths][0]!, target.symbol) };
  });
  return { edges: rewritten, resolvedCount };
}

// symbol -> defining paths, per package, from top-level chunks only (imports
// bind package-barrel exports, which are top-level declarations)
function indexTopLevelSymbols(
  chunks: SymbolChunk[],
  packages: WorkspacePackage[],
): Map<string, Map<string, Set<string>>> {
  const index = new Map<string, Map<string, Set<string>>>();
  for (const chunk of chunks) {
    if (!chunk.symbol || chunk.parentSymbol) continue;
    const pkg = packages.find(p => chunk.path.startsWith(`${p.dir}/`));
    if (!pkg) continue;
    let symbols = index.get(pkg.name);
    if (!symbols) index.set(pkg.name, (symbols = new Map()));
    let paths = symbols.get(chunk.symbol);
    if (!paths) symbols.set(chunk.symbol, (paths = new Set()));
    paths.add(chunk.path);
  }
  return index;
}

function parseExternalTarget(
  to: string,
  packages: WorkspacePackage[],
): { pkg: WorkspacePackage; symbol: string | null } | null {
  if (!to.startsWith('external:')) return null;
  const rest = to.slice('external:'.length);
  const hashIdx = rest.indexOf('#');
  const specifier = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
  const symbol = hashIdx === -1 ? null : rest.slice(hashIdx + 1);
  const pkg = packages.find(
    p => specifier === p.name || specifier.startsWith(`${p.name}/`),
  );
  return pkg ? { pkg, symbol } : null;
}
