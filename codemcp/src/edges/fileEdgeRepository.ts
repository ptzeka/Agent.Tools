import { FileGraphStore, type IGraphStore } from '@peritze/graphstore';

import type { EdgeRow, IEdgeRepository } from './types.js';

// delegates to @peritze/graphstore — the same store family codeindex publishes
// through, so reader and writer share one layout/contract. A future non-file
// IGraphStore implementation plugs in behind another IEdgeRepository here.
// listEdges stays unfiltered: get_relationships does fuzzy entity matching
// (symbol-name suffixes) that a store-side exact filter cannot express.

// reads the edges.jsonl sidecar co-located with each snapshot at
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
