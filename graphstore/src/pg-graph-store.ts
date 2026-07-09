// pg backend for IGraphStore. Reuses @peritze/vectorstore's connection plumbing
// (DbConnectionFactory/PgConnectionFactory) so a consumer can share one pool
// across its vector and graph stores.

import type { DbConnectionFactory } from '@peritze/vectorstore';
import { PgConnectionFactory } from '@peritze/vectorstore';
import type { EdgeFilter, EdgeType, GraphEdge, IGraphStore } from './graph-store.js';

export interface PgGraphStoreOptions {
  table?: string;
}

const DEFAULT_TABLE = 'code_edges';

interface EdgeRow {
  from_id: string;
  to_id: string;
  edge_type: EdgeType;
  line: number;
}

export class PgGraphStore implements IGraphStore {
  private readonly factory: DbConnectionFactory;
  private readonly table: string;

  // accepts a connection string or a ready factory so consumers can share one pool across stores
  constructor(connection: string | DbConnectionFactory, options: PgGraphStoreOptions = {}) {
    this.table = options.table ?? DEFAULT_TABLE;
    // interpolated into SQL, so it must be a bare identifier (optional schema prefix)
    if (!/^([A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*$/.test(this.table)) {
      throw new Error(`Invalid table name: ${this.table}`);
    }
    this.factory = typeof connection === 'string' ? new PgConnectionFactory(connection) : connection;
  }

  async ensureSchema(): Promise<void> {
    await this.factory.withTransaction(async conn => {
      await conn.query(
        `CREATE TABLE IF NOT EXISTS ${this.table} (
           namespace  TEXT NOT NULL,
           from_id    TEXT NOT NULL,
           to_id      TEXT NOT NULL,
           edge_type  TEXT NOT NULL,
           line       INT  NOT NULL
         )`,
      );
      await conn.query(
        `CREATE INDEX IF NOT EXISTS ${this.indexName()} ON ${this.table} (namespace)`,
      );
    });
  }

  async replaceNamespace(namespace: string, edges: GraphEdge[]): Promise<void> {
    await this.factory.withTransaction(async conn => {
      await conn.query(`DELETE FROM ${this.table} WHERE namespace = $1`, [namespace]);
      for (const edge of edges) {
        await conn.query(
          `INSERT INTO ${this.table} (namespace, from_id, to_id, edge_type, line)
           VALUES ($1, $2, $3, $4, $5)`,
          [namespace, edge.from, edge.to, edge.type, edge.line],
        );
      }
    });
  }

  async list(namespace: string, filter: EdgeFilter = {}, limit?: number): Promise<GraphEdge[]> {
    const clauses = ['namespace = $1'];
    const params: unknown[] = [namespace];
    if (filter.from !== undefined) {
      params.push(filter.from);
      clauses.push(`from_id = $${params.length}`);
    }
    if (filter.to !== undefined) {
      params.push(filter.to);
      clauses.push(`to_id = $${params.length}`);
    }
    if (filter.type !== undefined) {
      params.push(filter.type);
      clauses.push(`edge_type = $${params.length}`);
    }
    let sql =
      `SELECT from_id, to_id, edge_type, line FROM ${this.table} WHERE ${clauses.join(' AND ')}`;
    if (limit !== undefined) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }
    await using conn = await this.factory.getConnection();
    const result = await conn.query<EdgeRow>(sql, params);
    return result.rows.map(row => ({
      from: row.from_id,
      to: row.to_id,
      type: row.edge_type,
      line: row.line,
    }));
  }

  async deleteNamespace(namespace: string): Promise<void> {
    await using conn = await this.factory.getConnection();
    await conn.query(`DELETE FROM ${this.table} WHERE namespace = $1`, [namespace]);
  }

  async listNamespaces(): Promise<string[]> {
    await using conn = await this.factory.getConnection();
    const result = await conn.query<{ namespace: string }>(
      `SELECT DISTINCT namespace FROM ${this.table} ORDER BY namespace`,
    );
    return result.rows.map(row => row.namespace);
  }

  async close(): Promise<void> {
    await this.factory.end();
  }

  private indexName(): string {
    return `idx_${this.table.replace('.', '_')}_namespace`;
  }
}
