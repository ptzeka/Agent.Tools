import { describe, expect, test } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverWorkspacePackages,
  resolveWorkspaceEdges,
  type WorkspacePackage,
} from '../../src/publisher/workspaceResolution.js';
import type { CodeEdge, RawChunk } from '../../src/types.js';

function chunk(path: string, symbol: string | null, parentSymbol: string | null = null): RawChunk {
  return {
    path,
    area: 'backend',
    language: 'typescript',
    kind: 'interface',
    symbol,
    parentSymbol,
    startLine: 1,
    endLine: 5,
    content: '',
    imports: [],
  };
}

function edge(from: string, to: string): CodeEdge {
  return { from, to, type: 'imports', line: 1 };
}

const PACKAGES: WorkspacePackage[] = [
  { name: '@peritze/vectorstore', dir: 'vectorstore' },
  { name: '@peritze/mcp-tool-server', dir: 'mcp-tool-server' },
];

describe('resolveWorkspaceEdges', () => {
  test('rewrites a workspace-package symbol import to the defining file', () => {
    const chunks = [chunk('vectorstore/src/vector-store.ts', 'IVectorStore')];
    const edges = [edge('codemcp/src/retrieval.ts', 'external:@peritze/vectorstore#IVectorStore')];
    const result = resolveWorkspaceEdges(edges, chunks, PACKAGES);
    expect(result.resolvedCount).toBe(1);
    expect(result.edges[0]!.to).toBe('vectorstore/src/vector-store.ts#IVectorStore');
  });

  test('resolves subpath specifiers against the owning package', () => {
    const chunks = [chunk('mcp-tool-server/src/tool-server.ts', 'ToolServer')];
    const edges = [edge('codemcp/src/server.ts', 'external:@peritze/mcp-tool-server/tool-server#ToolServer')];
    const result = resolveWorkspaceEdges(edges, chunks, PACKAGES);
    expect(result.edges[0]!.to).toBe('mcp-tool-server/src/tool-server.ts#ToolServer');
  });

  test('leaves unmatched symbols external instead of guessing', () => {
    const chunks = [chunk('vectorstore/src/vector-store.ts', 'IVectorStore')];
    const edges = [edge('a.ts', 'external:@peritze/vectorstore#NoSuchSymbol')];
    const result = resolveWorkspaceEdges(edges, chunks, PACKAGES);
    expect(result.resolvedCount).toBe(0);
    expect(result.edges[0]!.to).toBe('external:@peritze/vectorstore#NoSuchSymbol');
  });

  test('leaves ambiguous definitions (same symbol in two files) external', () => {
    const chunks = [
      chunk('vectorstore/src/a.ts', 'Dup'),
      chunk('vectorstore/src/b.ts', 'Dup'),
    ];
    const edges = [edge('a.ts', 'external:@peritze/vectorstore#Dup')];
    expect(resolveWorkspaceEdges(edges, chunks, PACKAGES).resolvedCount).toBe(0);
  });

  test('ignores nested symbols — imports bind top-level declarations only', () => {
    const chunks = [chunk('vectorstore/src/a.ts', 'search', 'PgVectorStore')];
    const edges = [edge('a.ts', 'external:@peritze/vectorstore#search')];
    expect(resolveWorkspaceEdges(edges, chunks, PACKAGES).resolvedCount).toBe(0);
  });

  test('never touches truly external packages or bare module edges', () => {
    const chunks = [chunk('vectorstore/src/vector-store.ts', 'IVectorStore')];
    const edges = [
      edge('a.ts', 'external:commander#Command'),
      edge('a.ts', 'external:@peritze/vectorstore'),
    ];
    const result = resolveWorkspaceEdges(edges, chunks, PACKAGES);
    expect(result.resolvedCount).toBe(0);
    expect(result.edges.map(e => e.to)).toEqual(['external:commander#Command', 'external:@peritze/vectorstore']);
  });

  test('is a no-op for repos without workspace packages', () => {
    const edges = [edge('a.ts', 'external:@peritze/vectorstore#IVectorStore')];
    const result = resolveWorkspaceEdges(edges, [], []);
    expect(result.edges).toBe(edges);
    expect(result.resolvedCount).toBe(0);
  });
});

describe('discoverWorkspacePackages', () => {
  test('reads literal workspace dirs and expands single-level globs', () => {
    const root = mkdtempSync(join(tmpdir(), 'wsres-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['alpha', 'packages/*', 'missing'] }));
      mkdirSync(join(root, 'alpha'));
      writeFileSync(join(root, 'alpha', 'package.json'), JSON.stringify({ name: '@x/alpha' }));
      mkdirSync(join(root, 'packages', 'beta'), { recursive: true });
      writeFileSync(join(root, 'packages', 'beta', 'package.json'), JSON.stringify({ name: '@x/beta' }));
      mkdirSync(join(root, 'packages', 'no-manifest'));

      expect(discoverWorkspacePackages(root)).toEqual([
        { name: '@x/alpha', dir: 'alpha' },
        { name: '@x/beta', dir: 'packages/beta' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns [] when the root has no workspaces field or no package.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'wsres-'));
    try {
      expect(discoverWorkspacePackages(root)).toEqual([]);
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'plain' }));
      expect(discoverWorkspacePackages(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
