export type EdgeType = 'imports' | 'calls' | 'implements' | 'extends';

// mirrors @peritze/graphstore's GraphEdge — the writer/reader contract for edge rows.
// Endpoints are entity ids: `<path>`, `<path>#Symbol`, `<path>#Class.method`,
// `external:<module>`, `unresolved:<name>`
export interface EdgeRow {
  from: string;
  to: string;
  type: EdgeType;
  line: number;
}

export interface IEdgeRepository {
  listEdges(commitSha: string): Promise<EdgeRow[]>;
}
