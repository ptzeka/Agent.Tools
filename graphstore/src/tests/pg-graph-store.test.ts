import { describe, it, expect } from "@jest/globals";
import type { DbConnection, DbConnectionFactory, QueryResult } from "@peritze/vectorstore";
import { PgGraphStore, type GraphEdge } from "@peritze/graphstore";

// records every SQL call so tests can assert on the marshalled params without a live Postgres
class FakeConnection implements DbConnection {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  rows: unknown[] = [];

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    this.calls.push({ sql, params });
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
  async begin(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

class FakeFactory implements DbConnectionFactory {
  readonly conn = new FakeConnection();
  async getConnection(): Promise<DbConnection> {
    return this.conn;
  }
  async withTransaction<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T> {
    return fn(this.conn);
  }
  async end(): Promise<void> {}
}

function edge(from: string, to: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return { from, to, type: "imports", line: 1, ...overrides };
}

describe("PgGraphStore", () => {
  it("rejects table names that are not bare identifiers", () => {
    expect(() => new PgGraphStore(new FakeFactory(), { table: "x; DROP TABLE y" })).toThrow(/Invalid table/);
    expect(() => new PgGraphStore(new FakeFactory(), { table: "code.code_edges" })).not.toThrow();
  });

  it("replaceNamespace deletes the namespace then inserts each edge in one transaction", async () => {
    const factory = new FakeFactory();
    const store = new PgGraphStore(factory);
    await store.replaceNamespace("sha1", [edge("a.ts", "b.ts#X", { type: "calls", line: 4 })]);

    const [del, ins] = factory.conn.calls;
    expect(del!.sql).toContain("DELETE FROM code_edges");
    expect(del!.params).toEqual(["sha1"]);
    expect(ins!.sql).toContain("INSERT INTO code_edges");
    expect(ins!.params).toEqual(["sha1", "a.ts", "b.ts#X", "calls", 4]);
  });

  it("list builds AND-ed filter clauses with positional params and maps rows back", async () => {
    const factory = new FakeFactory();
    factory.conn.rows = [{ from_id: "a.ts", to_id: "b.ts#X", edge_type: "calls", line: 4 }];
    const store = new PgGraphStore(factory);

    const result = await store.list("sha1", { to: "b.ts#X", type: "calls" }, 10);
    expect(result).toEqual([edge("a.ts", "b.ts#X", { type: "calls", line: 4 })]);

    const call = factory.conn.calls[0]!;
    expect(call.sql).toContain("to_id = $2");
    expect(call.sql).toContain("edge_type = $3");
    expect(call.sql).toContain("LIMIT $4");
    expect(call.params).toEqual(["sha1", "b.ts#X", "calls", 10]);
  });

  it("listNamespaces returns distinct namespaces", async () => {
    const factory = new FakeFactory();
    factory.conn.rows = [{ namespace: "sha1" }, { namespace: "sha2" }];
    expect(await new PgGraphStore(factory).listNamespaces()).toEqual(["sha1", "sha2"]);
  });
});
