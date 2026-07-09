// the generic relationship fact: a typed, directed edge between two entity ids
// under an opaque namespace. the store never interprets namespace or endpoint
// ids — snapshot/entity semantics live in consumers (codeindex writes
// per-commit namespaces; codemcp joins endpoints against its chunk ids)
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly type: EdgeType;
  readonly line: number;
}

export type EdgeType = 'imports' | 'calls' | 'implements' | 'extends';

// single-hop, exact-match selection; every present field must match (AND-ed).
// fuzzy entity matching (symbol-name suffixes etc.) composes in the consumer
export interface EdgeFilter {
  readonly from?: string;
  readonly to?: string;
  readonly type?: EdgeType;
}

// edge storage over GraphEdge; namespace partitions, writes are whole-namespace
// replacement — a republish of the same snapshot is idempotent by construction
export interface IGraphStore {
  // replaces every edge in the namespace with `edges` (empty array clears it)
  replaceNamespace(namespace: string, edges: GraphEdge[]): Promise<void>;
  // exact-match retrieval, insertion order; omit the filter for all edges
  list(namespace: string, filter?: EdgeFilter, limit?: number): Promise<GraphEdge[]>;
  deleteNamespace(namespace: string): Promise<void>;
  listNamespaces(): Promise<string[]>;
  close(): Promise<void>;
}

export function matchesFilter(edge: GraphEdge, filter: EdgeFilter): boolean {
  if (filter.from !== undefined && edge.from !== filter.from) return false;
  if (filter.to !== undefined && edge.to !== filter.to) return false;
  if (filter.type !== undefined && edge.type !== filter.type) return false;
  return true;
}
