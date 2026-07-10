import {
  FileVectorStore,
  type DbConnectionFactory,
  type IVectorStore,
} from '@peritze/vectorstore';
import { FileGraphStore, type IGraphStore } from '@peritze/graphstore';
import type { CodeIndexConfig } from './config.js';
import type { CommitRepository } from './db/commitRepository.js';
import { FileConnectionFactory } from './db/file/fileConnectionFactory.js';
import { FileCommitRepositoryImpl } from './db/file/fileRepository.js';
import type { IParser } from './indexer/parsers/types.js';
import { RegexParser } from './indexer/parsers/regexParser.js';
import { TreeLineParser } from './indexer/parsers/treeLineParser.js';
import { CSharpTreeParser } from './indexer/parsers/csharpTreeParser.js';
import { CSharpFallbackParser } from './indexer/parsers/csharpFallbackParser.js';
import { CompositeParser } from './indexer/parsers/compositeParser.js';

// code chunks are partitioned by commit sha: namespace = sha, laid out as
// data/commits/<sha>/chunks.jsonl so the file backend stays byte-compatible-ish
const PARTITION_DIR = 'commits';
const RECORDS_FILE = 'chunks.jsonl';

export interface WiredWriter {
  // generic similarity store for chunk rows (namespace = commit sha)
  vectorStore: IVectorStore;
  // relationship store for edge rows (same namespace scheme)
  graphStore: IGraphStore;
  // commit metadata + migration journal live alongside, owned by codeindex
  factory: DbConnectionFactory;
  repo: CommitRepository;
  // true only for a SQL-capable backend; the migration runner uses this to apply .sql files
  // vs. just seeding the schema_versions journal (what the file backend does today)
  supportsSql: boolean;
  // create the stores' own tables/dirs before the first write (no-op on file)
  ensureStoreSchemas(): Promise<void>;
}

// the file backend is the only implementation today; a future backend adds a branch here
// keyed on config.backend, wiring its own IVectorStore/IGraphStore/CommitRepository/DbConnectionFactory
export function wireWriter(config: CodeIndexConfig): WiredWriter {
  return {
    vectorStore: new FileVectorStore({
      baseDir: config.fileDir,
      partitionDir: PARTITION_DIR,
      recordsFile: RECORDS_FILE,
    }),
    graphStore: new FileGraphStore({ baseDir: config.fileDir, partitionDir: PARTITION_DIR }),
    factory: new FileConnectionFactory(config.fileDir),
    repo: new FileCommitRepositoryImpl(),
    supportsSql: false,
    ensureStoreSchemas: async () => undefined,
  };
}

// AST extraction is the default per language family; each family's regex/heuristic chunker
// keeps its unparseable files indexed without taking down the other family's parsing
export function wireParser(): IParser {
  return new CompositeParser(
    new TreeLineParser(new RegexParser()),
    new CSharpTreeParser(new CSharpFallbackParser()),
  );
}
