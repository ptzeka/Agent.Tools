import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { CodeIndexConfig } from '../config.js';
import type { DbConnectionFactory, IVectorStore, VectorRecord, VectorSummary } from '@peritze/vectorstore';
import type { IGraphStore } from '@peritze/graphstore';
import type { CommitRepository } from '../db/commitRepository.js';
import type { IVectorService } from '@peritze/vectorizer';
import type { CodeEdge, CommitRow, RawChunk } from '../types.js';
import { walkRepository, type DiscoveredFile } from '../indexer/walker.js';
import { chunkFile } from '../indexer/chunkers/index.js';
import { areaForPath, claudeMdLineageForFile, languageForPath } from '../indexer/metadata.js';
import { changedFilesSince, isAncestor, readGitContext, type GitContext } from './git.js';
import { discoverWorkspacePackages, resolveWorkspaceEdges, type SymbolChunk } from './workspaceResolution.js';
import type { IParser } from '../indexer/parsers/types.js';

const EMBED_BATCH_SIZE = 32;

export interface PublishResult {
  commitSha: string;
  branch: string;
  repository: string;
  fileCount: number;
  chunkCount: number;
  edgeCount: number;
  modelId: string;
  // 'full' when every file was re-chunked; 'incremental' when only the git diff
  // against `baselineSha` was reprocessed
  mode: 'full' | 'incremental';
  baselineSha?: string;
  touchedFileCount?: number;
  prunedShas: string[];
}

export interface PublishDeps {
  config: CodeIndexConfig;
  vectorStore: IVectorStore;
  graphStore: IGraphStore;
  factory: DbConnectionFactory;
  repo: CommitRepository;
  embedder: IVectorService;
  parser: IParser;
  // force a from-scratch publish even when a valid diff baseline exists
  full?: boolean;
  log?: (msg: string) => void;
}

export async function publish(deps: PublishDeps): Promise<PublishResult> {
  const { config, vectorStore, graphStore, factory, repo, embedder, parser } = deps;
  const log = deps.log ?? (() => undefined);

  const rootDir = resolve(config.rootDir);
  const git = readGitContext(rootDir, config.branch, config.repository);
  log(`indexing commit ${git.commitSha} (branch ${git.branch}, repository ${git.repository})${git.isDirty ? ' [dirty]' : ''}`);

  const files = walkRepository({ rootDir, excludeGlobs: config.excludeGlobs });
  log(`walked ${files.length} indexable files`);

  const baseline = deps.full ? null : await pickBaseline(deps, rootDir, git);
  const outcome = baseline
    ? await publishIncremental(deps, rootDir, git, files, baseline)
    : await publishFull(deps, rootDir, git, files);

  const commit: CommitRow = {
    commitSha: git.commitSha,
    branch: git.branch,
    repository: git.repository,
    embedModel: embedder.modelId,
    embedDim: embedder.dim,
    fileCount: files.length,
    chunkCount: outcome.chunkCount,
  };
  await factory.withTransaction(async conn => {
    await repo.upsertCommit(conn, commit);
  });

  // one snapshot per branch: every other indexed commit on this branch is superseded now
  const prunedShas = await pruneBranchSnapshots(deps, git);

  log(
    `published ${outcome.chunkCount} chunks + ${outcome.edgeCount} edges for ${commit.commitSha} ` +
    `(${commit.repository}) using ${embedder.modelId} [${outcome.mode}]`,
  );
  return {
    commitSha: commit.commitSha,
    branch: commit.branch,
    repository: commit.repository,
    fileCount: commit.fileCount,
    chunkCount: commit.chunkCount,
    edgeCount: outcome.edgeCount,
    modelId: embedder.modelId,
    mode: outcome.mode,
    ...(baseline ? { baselineSha: baseline.commitSha, touchedFileCount: outcome.touchedFileCount } : {}),
    prunedShas,
  };
}

interface PublishOutcome {
  mode: 'full' | 'incremental';
  chunkCount: number;
  edgeCount: number;
  touchedFileCount?: number;
}

// ---------------------------------------------------------------------------
// full path: chunk + embed the whole walk into a fresh namespace

async function publishFull(
  deps: PublishDeps,
  rootDir: string,
  git: GitContext,
  files: DiscoveredFile[],
): Promise<PublishOutcome> {
  const { vectorStore, graphStore, embedder, parser } = deps;
  const log = deps.log ?? (() => undefined);

  const { rawChunks, edges: parsedEdges } = chunkFiles(files, parser, log);
  log(`produced ${rawChunks.length} raw chunks, ${parsedEdges.length} edges`);

  let edges = parsedEdges;
  const workspacePackages = discoverWorkspacePackages(rootDir);
  if (workspacePackages.length > 0) {
    const resolution = resolveWorkspaceEdges(edges, rawChunks, workspacePackages);
    edges = resolution.edges;
    log(`resolved ${resolution.resolvedCount} cross-package edges via ${workspacePackages.length} workspace package(s)`);
  }

  const records = await embedChunks(rootDir, git.commitSha, rawChunks, embedder, log);

  // chunks first: a fresh namespace then upsert is the idempotent republish; the
  // file backend co-locates chunks.jsonl + commit.json under commits/<sha>/, and
  // deleteNamespace clears the dir, so commit metadata must be written afterwards
  await vectorStore.deleteNamespace(git.commitSha);
  await vectorStore.upsert(records);
  await graphStore.replaceNamespace(git.commitSha, edges);

  return { mode: 'full', chunkCount: records.length, edgeCount: edges.length };
}

// ---------------------------------------------------------------------------
// incremental path: seed the namespace from the baseline snapshot, then only
// reprocess files git says diverged from it

async function publishIncremental(
  deps: PublishDeps,
  rootDir: string,
  git: GitContext,
  files: DiscoveredFile[],
  baseline: CommitRow,
): Promise<PublishOutcome> {
  const { vectorStore, graphStore, embedder, parser } = deps;
  const log = deps.log ?? (() => undefined);

  const touched = new Set(changedFilesSince(rootDir, baseline.commitSha).touched);
  log(`diff vs baseline ${baseline.commitSha}: ${touched.size} touched file(s)`);

  if (baseline.commitSha !== git.commitSha) {
    await vectorStore.copyNamespace(baseline.commitSha, git.commitSha);
  }

  // stale chunks out first; what survives seeds the workspace symbol index below
  const summaries = await vectorStore.listSummaries(git.commitSha);
  const staleIds = summaries
    .filter(s => touched.has(String(s.metadata['path'])))
    .map(s => s.id);
  if (staleIds.length > 0) {
    await vectorStore.delete(git.commitSha, staleIds);
  }
  const survivors = summaries.filter(s => !touched.has(String(s.metadata['path'])));

  // a touched path still present in the walk gets re-chunked; one that is gone
  // (deleted, renamed away, or newly excluded) is covered by the deletion above
  const byPath = new Map(files.map(f => [f.relativePath, f]));
  const reindexFiles = [...touched]
    .map(p => byPath.get(p))
    .filter((f): f is DiscoveredFile => f !== undefined);
  const { rawChunks, edges: newEdges } = chunkFiles(reindexFiles, parser, log);
  log(`re-chunked ${reindexFiles.length} file(s) into ${rawChunks.length} chunks, ${newEdges.length} edges`);

  // edges FROM a touched file are stale; edges pointing TO one may dangle, which
  // readers already tolerate (same as external:/unresolved: targets)
  const keptEdges = (await graphStore.list(baseline.commitSha))
    .filter(e => !entityBelongsTo(e.from, touched));
  let edges = [...keptEdges, ...newEdges];

  const workspacePackages = discoverWorkspacePackages(rootDir);
  if (workspacePackages.length > 0) {
    // re-resolve over kept + new: a touched file may now define (or no longer
    // define) the target of a previously-unresolved external: edge
    const symbolChunks: SymbolChunk[] = [
      ...survivors.map(summaryToSymbolChunk),
      ...rawChunks,
    ];
    const resolution = resolveWorkspaceEdges(edges, symbolChunks, workspacePackages);
    edges = resolution.edges;
    log(`resolved ${resolution.resolvedCount} cross-package edges via ${workspacePackages.length} workspace package(s)`);
  }

  const records = await embedChunks(rootDir, git.commitSha, rawChunks, embedder, log);
  await vectorStore.upsert(records);
  await graphStore.replaceNamespace(git.commitSha, edges);

  return {
    mode: 'incremental',
    chunkCount: survivors.length + records.length,
    edgeCount: edges.length,
    touchedFileCount: touched.size,
  };
}

// the newest previously-indexed snapshot this working tree can be diffed against:
// same embedding space, and either HEAD itself (dirty republish) or a git ancestor
// of HEAD. Anything else — different model, diverged branch, no git — means full
async function pickBaseline(
  deps: PublishDeps,
  rootDir: string,
  git: GitContext,
): Promise<CommitRow | null> {
  const { factory, repo, embedder } = deps;
  const log = deps.log ?? (() => undefined);

  await using conn = await factory.getConnection();
  const shas = await repo.listCommitShas(conn, git.repository);
  let best: CommitRow | null = null;
  for (const sha of shas) {
    const row = await repo.getCommit(conn, sha);
    if (!row) continue;
    if (row.embedModel !== embedder.modelId || row.embedDim !== embedder.dim) continue;
    if (sha !== git.commitSha && !isAncestor(rootDir, sha, git.commitSha)) continue;
    if (!best || indexedAtMs(row) > indexedAtMs(best)) best = row;
  }
  if (best) log(`incremental baseline: ${best.commitSha} (indexed ${best.indexedAt?.toISOString() ?? 'unknown'})`);
  else log('no usable baseline snapshot — publishing full');
  return best;
}

async function pruneBranchSnapshots(deps: PublishDeps, git: GitContext): Promise<string[]> {
  const { vectorStore, graphStore, factory, repo } = deps;
  const log = deps.log ?? (() => undefined);

  await using conn = await factory.getConnection();
  const pruned: string[] = [];
  for (const sha of await repo.listCommitShas(conn, git.repository)) {
    if (sha === git.commitSha) continue;
    const row = await repo.getCommit(conn, sha);
    // unreadable rows are skipped: without a branch we can't prove the snapshot is superseded
    if (!row || row.branch !== git.branch) continue;
    log(`pruning superseded snapshot ${sha} (branch ${row.branch})`);
    await vectorStore.deleteNamespace(sha);
    await graphStore.deleteNamespace(sha);
    await repo.deleteCommit(conn, sha);
    pruned.push(sha);
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// shared helpers

function chunkFiles(
  files: DiscoveredFile[],
  parser: IParser,
  log: (msg: string) => void,
): { rawChunks: RawChunk[]; edges: CodeEdge[] } {
  const rawChunks: RawChunk[] = [];
  const edges: CodeEdge[] = [];
  for (const file of files) {
    const language = languageForPath(file.relativePath);
    const area = areaForPath(file.relativePath);
    try {
      const parsed = chunkFile({
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        area,
        language,
      }, parser);
      rawChunks.push(...parsed.chunks);
      edges.push(...parsed.edges);
    } catch (err) {
      log(`WARN  failed to chunk ${file.relativePath}: ${(err as Error).message}`);
    }
  }
  return { rawChunks, edges };
}

async function embedChunks(
  rootDir: string,
  commitSha: string,
  rawChunks: RawChunk[],
  embedder: IVectorService,
  log: (msg: string) => void,
): Promise<VectorRecord[]> {
  const records: VectorRecord[] = [];
  for (let i = 0; i < rawChunks.length; i += EMBED_BATCH_SIZE) {
    const batch = rawChunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(b => embedInputFor(b));
    const vectors = await embedder.embedBatch(texts);
    if (vectors.length !== batch.length) {
      throw new Error(`Embed adapter returned ${vectors.length} vectors for ${batch.length} inputs`);
    }
    for (let j = 0; j < batch.length; j++) {
      const raw = batch[j]!;
      const embedding = vectors[j]!;
      if (embedding.length !== embedder.dim) {
        throw new Error(`Embedding has dim ${embedding.length}, expected ${embedder.dim}`);
      }
      records.push(toRecord(rootDir, commitSha, raw, embedding));
    }
    log(`embedded ${Math.min(i + EMBED_BATCH_SIZE, rawChunks.length)}/${rawChunks.length}`);
  }
  return records;
}

// edge endpoints are `<path>` or `<path>#Symbol` (see CodeEdge in types.ts), so
// membership is exact path or a `<path>#` prefix — never plain startsWith, which
// would also match sibling files like `foo.ts` vs `foo.tsx`
function entityBelongsTo(entityId: string, paths: Set<string>): boolean {
  if (paths.has(entityId)) return true;
  const hashIdx = entityId.indexOf('#');
  return hashIdx > 0 && paths.has(entityId.slice(0, hashIdx));
}

function summaryToSymbolChunk(summary: VectorSummary): SymbolChunk {
  return {
    path: String(summary.metadata['path'] ?? ''),
    symbol: typeof summary.metadata['symbol'] === 'string' ? (summary.metadata['symbol'] as string) : null,
    parentSymbol: typeof summary.metadata['parentSymbol'] === 'string' ? (summary.metadata['parentSymbol'] as string) : null,
  };
}

function indexedAtMs(row: CommitRow): number {
  return row.indexedAt?.getTime() ?? 0;
}

// code fields collapse into the generic record's opaque metadata; id is stable
// per chunk so a republish of the same commit upserts in place
function toRecord(rootDir: string, commitSha: string, raw: RawChunk, embedding: number[]): VectorRecord {
  return {
    id: `${raw.path}#${raw.startLine}-${raw.endLine}`,
    namespace: commitSha,
    content: raw.content,
    embedding,
    metadata: {
      path: raw.path,
      area: raw.area,
      language: raw.language,
      kind: raw.kind,
      symbol: raw.symbol,
      parentSymbol: raw.parentSymbol,
      startLine: raw.startLine,
      endLine: raw.endLine,
      contentHash: sha256(raw.content),
      imports: raw.imports,
      claudeMd: claudeMdLineageForFile(rootDir, raw.path),
    },
  };
}

function embedInputFor(raw: RawChunk): string {
  // Prefix structural context so the embedder gets some semantic anchoring
  // (file path, symbol) along with the raw text.
  const header = [
    `path: ${raw.path}`,
    `lang: ${raw.language}`,
    `kind: ${raw.kind}`,
    raw.symbol ? `symbol: ${raw.symbol}` : null,
    raw.parentSymbol ? `parent: ${raw.parentSymbol}` : null,
  ].filter(Boolean).join('\n');
  return `${header}\n---\n${raw.content}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
