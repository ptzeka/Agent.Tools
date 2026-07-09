import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileGraphStore, type GraphEdge } from "@peritze/graphstore";

function edge(from: string, to: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return { from, to, type: "imports", line: 1, ...overrides };
}

let baseDir: string;
let store: FileGraphStore;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "graphstore-"));
  store = new FileGraphStore({ baseDir, partitionDir: "commits" });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("FileGraphStore", () => {
  it("round-trips edges through replaceNamespace and list", async () => {
    const edges = [edge("a.ts", "b.ts#X"), edge("a.ts#Y", "external:pg", { type: "calls", line: 9 })];
    await store.replaceNamespace("sha1", edges);
    expect(await store.list("sha1")).toEqual(edges);
  });

  it("stays byte-compatible with the edges.jsonl sidecar layout", async () => {
    await store.replaceNamespace("sha1", [edge("a.ts", "b.ts#X", { line: 3 })]);
    const raw = readFileSync(join(baseDir, "commits", "sha1", "edges.jsonl"), "utf-8");
    expect(raw).toBe('{"from":"a.ts","to":"b.ts#X","type":"imports","line":3}\n');
  });

  it("reads a pre-existing edges.jsonl written by codeindex", async () => {
    const dir = join(baseDir, "commits", "legacy");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "edges.jsonl"), '{"from":"x.ts","to":"y.ts","type":"extends","line":7}\n');
    expect(await store.list("legacy")).toEqual([edge("x.ts", "y.ts", { type: "extends", line: 7 })]);
  });

  it("replaces the whole namespace on rewrite (idempotent republish)", async () => {
    await store.replaceNamespace("sha1", [edge("old.ts", "gone.ts")]);
    await store.replaceNamespace("sha1", [edge("new.ts", "kept.ts")]);
    expect(await store.list("sha1")).toEqual([edge("new.ts", "kept.ts")]);
  });

  it("filters by from, to, and type, AND-ed, with an optional limit", async () => {
    await store.replaceNamespace("sha1", [
      edge("a.ts", "t.ts#S"),
      edge("b.ts", "t.ts#S", { type: "calls" }),
      edge("a.ts", "other.ts"),
    ]);
    expect(await store.list("sha1", { to: "t.ts#S" })).toHaveLength(2);
    expect(await store.list("sha1", { to: "t.ts#S", type: "calls" })).toEqual([
      edge("b.ts", "t.ts#S", { type: "calls" }),
    ]);
    expect(await store.list("sha1", {}, 1)).toEqual([edge("a.ts", "t.ts#S")]);
  });

  it("skips corrupt lines instead of failing the namespace", async () => {
    const dir = join(baseDir, "commits", "sha1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "edges.jsonl"), 'not-json\n{"from":"a.ts","to":"b.ts","type":"imports","line":1}\n');
    expect(await store.list("sha1")).toEqual([edge("a.ts", "b.ts")]);
  });

  it("returns [] for a namespace that has no edges file", async () => {
    expect(await store.list("nope")).toEqual([]);
  });

  it("deleteNamespace removes only the edges file, not sibling sidecars", async () => {
    const dir = join(baseDir, "commits", "sha1");
    await store.replaceNamespace("sha1", [edge("a.ts", "b.ts")]);
    writeFileSync(join(dir, "commit.json"), "{}");
    await store.deleteNamespace("sha1");
    expect(existsSync(join(dir, "edges.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "commit.json"))).toBe(true);
  });

  it("lists only namespaces that actually hold an edges file", async () => {
    await store.replaceNamespace("sha1", [edge("a.ts", "b.ts")]);
    mkdirSync(join(baseDir, "commits", "chunks-only"), { recursive: true });
    expect(await store.listNamespaces()).toEqual(["sha1"]);
  });

  it("rejects namespaces that could traverse the filesystem", async () => {
    await expect(store.list("../evil")).rejects.toThrow(/Invalid namespace/);
    await expect(store.replaceNamespace("a/b", [])).rejects.toThrow(/Invalid namespace/);
  });
});
