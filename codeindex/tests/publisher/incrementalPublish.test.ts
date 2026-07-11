import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileVectorStore } from '@peritze/vectorstore';
import { FileGraphStore } from '@peritze/graphstore';
import type { IVectorService } from '@peritze/vectorizer';
import { publish, type PublishDeps } from '../../src/publisher/publish.js';
import { FileConnectionFactory } from '../../src/db/file/fileConnectionFactory.js';
import { FileCommitRepositoryImpl } from '../../src/db/file/fileRepository.js';
import { wireParser } from '../../src/wiring.js';
import type { CodeIndexConfig } from '../../src/config.js';

// end-to-end over a real temp git repo + the file backend; only embedding is faked,
// and the fake records its inputs so tests can assert which files were re-embedded
class RecordingEmbedder implements IVectorService {
  readonly dim = 3;
  embeddedTexts: string[] = [];

  constructor(readonly modelId: string = 'test:fake-3') {}

  async embedBatch(texts: string[]): Promise<number[][]> {
    this.embeddedTexts.push(...texts);
    return texts.map((_, i) => [1, i % 2, 0]);
  }
}

let repoDir: string;
let dataDir: string;
let embedder: RecordingEmbedder;

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function makeDeps(overrides: Partial<PublishDeps> = {}): PublishDeps {
  const config: CodeIndexConfig = {
    backend: 'file',
    branch: 'main',
    embedProvider: 'local',
    embedDim: 3,
    fileDir: dataDir,
    rootDir: repoDir,
    excludeGlobs: ['**/.git/**'],
    repository: 'test/incremental',
  };
  return {
    config,
    vectorStore: new FileVectorStore({ baseDir: dataDir, partitionDir: 'commits', recordsFile: 'chunks.jsonl' }),
    graphStore: new FileGraphStore({ baseDir: dataDir, partitionDir: 'commits' }),
    factory: new FileConnectionFactory(dataDir),
    repo: new FileCommitRepositoryImpl(),
    embedder,
    parser: wireParser(),
    ...overrides,
  };
}

async function edgesInNamespace(sha: string) {
  return new FileGraphStore({ baseDir: dataDir, partitionDir: 'commits' }).list(sha);
}

function embeddedPaths(): Set<string | undefined> {
  return new Set(embedder.embeddedTexts.map(t => /path: (.+)/.exec(t)?.[1]));
}

async function pathsInNamespace(sha: string): Promise<Set<string>> {
  const store = new FileVectorStore({ baseDir: dataDir, partitionDir: 'commits', recordsFile: 'chunks.jsonl' });
  const summaries = await store.listSummaries(sha);
  return new Set(summaries.map(s => String(s.metadata['path'])));
}

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'codeindex-repo-'));
  dataDir = mkdtempSync(join(tmpdir(), 'codeindex-data-'));
  embedder = new RecordingEmbedder();

  git('init -b main');
  git('config user.email test@example.com');
  git('config user.name test');
  writeFileSync(join(repoDir, 'alpha.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  writeFileSync(join(repoDir, 'beta.ts'), 'export function beta(): number {\n  return 2;\n}\n');
  writeFileSync(join(repoDir, 'doomed.ts'), 'export function doomed(): number {\n  return 3;\n}\n');
  git('add .');
  git('commit -m first');

  // the file connection factory expects the schema journal dir shape ensureSchemaVersionsTable creates
  const factory = new FileConnectionFactory(dataDir);
  const conn = await factory.getConnection();
  await new FileCommitRepositoryImpl().ensureSchemaVersionsTable(conn);
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('incremental publish', () => {
  it('publishes full when no baseline snapshot exists', async () => {
    const result = await publish(makeDeps());
    expect(result.mode).toBe('full');
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.prunedShas).toEqual([]);
  });

  it('re-embeds only touched files against the previous snapshot and prunes it', async () => {
    const first = await publish(makeDeps());

    writeFileSync(join(repoDir, 'alpha.ts'), 'export function alpha(): number {\n  return 42;\n}\n');
    writeFileSync(join(repoDir, 'gamma.ts'), 'export function gamma(): number {\n  return 4;\n}\n');
    rmSync(join(repoDir, 'doomed.ts'));
    git('add .');
    git('commit -m second');

    embedder.embeddedTexts = [];
    const second = await publish(makeDeps());

    expect(second.mode).toBe('incremental');
    expect(second.baselineSha).toBe(first.commitSha);
    expect(second.commitSha).not.toBe(first.commitSha);
    // one snapshot per branch: the superseded first commit is gone
    expect(second.prunedShas).toEqual([first.commitSha]);

    // only the touched files crossed the embedder
    const embeddedPaths = new Set(
      embedder.embeddedTexts.map(t => /path: (.+)/.exec(t)?.[1]),
    );
    expect(embeddedPaths.has('alpha.ts')).toBe(true);
    expect(embeddedPaths.has('gamma.ts')).toBe(true);
    expect(embeddedPaths.has('beta.ts')).toBe(false);
    expect(embeddedPaths.has('doomed.ts')).toBe(false);

    const paths = await pathsInNamespace(second.commitSha);
    expect(paths.has('alpha.ts')).toBe(true);
    expect(paths.has('beta.ts')).toBe(true);      // carried over from the baseline copy
    expect(paths.has('gamma.ts')).toBe(true);     // newly added
    expect(paths.has('doomed.ts')).toBe(false);   // deleted file's chunks removed

    // the updated content, not the baseline's, is what the namespace serves
    const store = new FileVectorStore({ baseDir: dataDir, partitionDir: 'commits', recordsFile: 'chunks.jsonl' });
    const alphaChunks = await store.list(second.commitSha, { path: 'alpha.ts' });
    expect(alphaChunks.some(c => c.content.includes('return 42'))).toBe(true);
  });

  it('diffs the dirty working tree against a baseline at the same HEAD', async () => {
    const first = await publish(makeDeps());

    writeFileSync(join(repoDir, 'beta.ts'), 'export function beta(): number {\n  return 99;\n}\n');
    embedder.embeddedTexts = [];
    const second = await publish(makeDeps());

    expect(second.mode).toBe('incremental');
    expect(second.commitSha).toBe(first.commitSha);
    expect(second.prunedShas).toEqual([]);

    const store = new FileVectorStore({ baseDir: dataDir, partitionDir: 'commits', recordsFile: 'chunks.jsonl' });
    const betaChunks = await store.list(second.commitSha, { path: 'beta.ts' });
    expect(betaChunks.some(c => c.content.includes('return 99'))).toBe(true);
  });

  it('falls back to full when the stored embed model differs', async () => {
    await publish(makeDeps());

    git('commit --allow-empty -m second');
    const second = await publish(makeDeps({ embedder: new RecordingEmbedder('test:other-3') }));

    expect(second.mode).toBe('full');
  });

  it('honors the full flag even when a baseline exists', async () => {
    await publish(makeDeps());
    git('commit --allow-empty -m second');
    const second = await publish(makeDeps({ full: true }));
    expect(second.mode).toBe('full');
  });

  it('regenerates every file from scratch on a full publish, ignoring the diff', async () => {
    await publish(makeDeps());

    // only alpha diverges, but full must re-embed the untouched files too
    writeFileSync(join(repoDir, 'alpha.ts'), 'export function alpha(): number {\n  return 7;\n}\n');
    embedder.embeddedTexts = [];
    const second = await publish(makeDeps({ full: true }));

    expect(second.mode).toBe('full');
    const paths = embeddedPaths();
    expect(paths.has('alpha.ts')).toBe(true);
    expect(paths.has('beta.ts')).toBe(true);
    expect(paths.has('doomed.ts')).toBe(true);

    expect(await pathsInNamespace(second.commitSha)).toEqual(
      new Set(['alpha.ts', 'beta.ts', 'doomed.ts']),
    );
  });

  it('deleting a file removes its chunks and outgoing edges but keeps incoming danglers', async () => {
    // alpha -> doomed -> beta, so the deleted file has edges on both sides
    writeFileSync(
      join(repoDir, 'alpha.ts'),
      "import { doomed } from './doomed.js';\nexport function alpha(): number {\n  return doomed();\n}\n",
    );
    writeFileSync(
      join(repoDir, 'doomed.ts'),
      "import { beta } from './beta.js';\nexport function doomed(): number {\n  return beta();\n}\n",
    );
    git('add .');
    git('commit -m wire-imports');
    const first = await publish(makeDeps());

    const before = await edgesInNamespace(first.commitSha);
    expect(before.some(e => e.from.startsWith('doomed.ts') && e.to.startsWith('beta.ts'))).toBe(true);
    expect(before.some(e => e.from.startsWith('alpha.ts') && e.to.startsWith('doomed.ts'))).toBe(true);

    rmSync(join(repoDir, 'doomed.ts'));
    git('add .');
    git('commit -m delete-doomed');
    embedder.embeddedTexts = [];
    const second = await publish(makeDeps());

    expect(second.mode).toBe('incremental');
    // nothing re-embedded: the only touched file is gone from the walk
    expect(embedder.embeddedTexts).toEqual([]);
    expect((await pathsInNamespace(second.commitSha)).has('doomed.ts')).toBe(false);

    const after = await edgesInNamespace(second.commitSha);
    // the deleted file owned its outgoing edges — gone with it
    expect(after.some(e => e.from.startsWith('doomed.ts'))).toBe(false);
    // untouched alpha still contains the (now broken) import, so its edge dangles by design
    expect(after.some(e => e.from.startsWith('alpha.ts') && e.to.startsWith('doomed.ts'))).toBe(true);
  });

  it('force clears the stored snapshot and regenerates the whole commit', async () => {
    const first = await publish(makeDeps());

    // metadata/data drift: chunk data vanishes while commit.json survives, which
    // a plain incremental publish would trust and silently produce a partial index
    rmSync(join(dataDir, 'commits', first.commitSha, 'chunks.jsonl'));

    embedder.embeddedTexts = [];
    const second = await publish(makeDeps({ force: true }));

    expect(second.mode).toBe('full');
    expect(second.baselineSha).toBeUndefined();
    expect(second.commitSha).toBe(first.commitSha);

    const paths = embeddedPaths();
    expect(paths.has('alpha.ts')).toBe(true);
    expect(paths.has('beta.ts')).toBe(true);
    expect(paths.has('doomed.ts')).toBe(true);
    expect(await pathsInNamespace(second.commitSha)).toEqual(
      new Set(['alpha.ts', 'beta.ts', 'doomed.ts']),
    );
  });

  it('deleting every file empties the snapshot incrementally', async () => {
    await publish(makeDeps());

    rmSync(join(repoDir, 'alpha.ts'));
    rmSync(join(repoDir, 'beta.ts'));
    rmSync(join(repoDir, 'doomed.ts'));
    git('add .');
    git('commit -m delete-all');
    embedder.embeddedTexts = [];
    const second = await publish(makeDeps());

    expect(second.mode).toBe('incremental');
    expect(second.touchedFileCount).toBe(3);
    expect(second.chunkCount).toBe(0);
    expect(second.edgeCount).toBe(0);
    expect(embedder.embeddedTexts).toEqual([]);
    expect(await pathsInNamespace(second.commitSha)).toEqual(new Set());
    expect(await edgesInNamespace(second.commitSha)).toEqual([]);
  });
});
