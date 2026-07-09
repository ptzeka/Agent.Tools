import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import type { EdgeFilter, GraphEdge, IGraphStore } from './graph-store.js';
import { matchesFilter } from './graph-store.js';

export interface FileGraphStoreOptions {
  baseDir?: string;
  // optional layout prefix so consumers stay byte-compatible: 'commits' for code snapshots
  partitionDir?: string;
  edgesFile?: string;
}

const DEFAULT_BASE_DIR = 'data';
const DEFAULT_EDGES_FILE = 'edges.jsonl';

// file backend rooted at `<baseDir>/<partitionDir>/<namespace>/<edgesFile>` — one
// GraphEdge per line, whole-file replacement on write. With partitionDir 'commits'
// this is byte-identical to the edges.jsonl sidecar codeindex has always published,
// so existing snapshots keep working with zero migration
export class FileGraphStore implements IGraphStore {
  private readonly baseDir: string;
  private readonly partitionDir: string;
  private readonly edgesFile: string;

  constructor(options: FileGraphStoreOptions = {}) {
    this.baseDir = resolve(options.baseDir ?? DEFAULT_BASE_DIR);
    this.partitionDir = options.partitionDir ?? '';
    this.edgesFile = options.edgesFile ?? DEFAULT_EDGES_FILE;
  }

  async replaceNamespace(namespace: string, edges: GraphEdge[]): Promise<void> {
    const dir = this.namespaceDir(namespace);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const lines = edges.map(edge => JSON.stringify(edge)).join('\n');
    writeFileSync(join(dir, this.edgesFile), lines.length > 0 ? lines + '\n' : '', 'utf-8');
  }

  async list(namespace: string, filter: EdgeFilter = {}, limit?: number): Promise<GraphEdge[]> {
    const path = join(this.namespaceDir(namespace), this.edgesFile);
    if (!existsSync(path)) return [];
    const edges: GraphEdge[] = [];
    for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      let edge: GraphEdge;
      try {
        edge = JSON.parse(line) as GraphEdge;
      } catch {
        continue; // a torn/corrupt line loses one edge, not the namespace
      }
      if (!matchesFilter(edge, filter)) continue;
      edges.push(edge);
      if (limit !== undefined && edges.length >= limit) break;
    }
    return edges;
  }

  // removes only this store's file — the namespace dir is shared with other
  // sidecars (chunks.jsonl, commit.json) owned by other stores
  async deleteNamespace(namespace: string): Promise<void> {
    rmSync(join(this.namespaceDir(namespace), this.edgesFile), { force: true });
  }

  async listNamespaces(): Promise<string[]> {
    const dir = this.partitionDir ? join(this.baseDir, this.partitionDir) : this.baseDir;
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(dir, entry.name, this.edgesFile)))
      .map(entry => entry.name);
  }

  async close(): Promise<void> {
    // nothing to release — every operation opens and closes its own file
  }

  private namespaceDir(namespace: string): string {
    // namespaces become directory names; reject separators and traversal
    if (!/^[A-Za-z0-9_\-.]+$/.test(namespace) || namespace.includes('..')) {
      throw new Error(`Invalid namespace: ${namespace}`);
    }
    return this.partitionDir
      ? join(this.baseDir, this.partitionDir, namespace)
      : join(this.baseDir, namespace);
  }
}
