import { FileGraphStore, PgGraphStore, type IGraphStore } from '@peritze/graphstore';

import type { EdgeRow, IEdgeRepository } from './types.js';

// both backends delegate to @peritze/graphstore — the same store family codeindex
// publishes through, so reader and writer share one layout/table contract.
// listEdges stays unfiltered: get_relationships does fuzzy entity matching
// (symbol-name suffixes) that a store-side exact filter cannot express.

// file backend reads the edges.jsonl sidecar co-located with each snapshot at
// <baseDir>/commits/<sha>/edges.jsonl; read-per-call like the chunk store, so a
// republish is visible without a server restart
export class FileEdgeRepository implements IEdgeRepository {
  private readonly store: IGraphStore;

  constructor(baseDir: string) {
    this.store = new FileGraphStore({ baseDir, partitionDir: 'commits' });
  }

  async listEdges(commitSha: string): Promise<EdgeRow[]> {
    return this.store.list(commitSha);
  }
}

// pg backend reads the code_edges table codeindex's PgGraphStore publishes into
export class PgEdgeRepository implements IEdgeRepository {
  private readonly store: IGraphStore;

  constructor(connectionString: string) {
    this.store = new PgGraphStore(connectionString);
  }

  async listEdges(commitSha: string): Promise<EdgeRow[]> {
    return this.store.list(commitSha);
  }
}
