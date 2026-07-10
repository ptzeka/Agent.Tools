import { FileVectorStore, type IVectorStore } from '@peritze/vectorstore';
import { VectorService } from '@peritze/vectorizer';
import type { MemoMcpConfig } from './config.js';
import { MemoryRepository } from './memory/memoryRepository.js';
import { LocalReranker } from './rerank/localReranker.js';

// memories live under data/memories/<collection>/records.jsonl, parallel to codeindex's commits/<sha>/chunks.jsonl
const PARTITION_DIR = 'memories';
const RECORDS_FILE = 'records.jsonl';

export interface Wired {
  repository: MemoryRepository;
  store: IVectorStore;
}

export function wire(config: MemoMcpConfig): Wired {
  const store = wireStore(config);
  const embedder = VectorService.fromProvider(config.embedProvider, config.embedDim);
  // local stand-in for the configured "reranker" role (models.json) until a real cross-encoder is wired
  const reranker = new LocalReranker();
  return { repository: new MemoryRepository(store, embedder, reranker), store };
}

// the file backend is the only implementation today; a future backend adds a branch here
// keyed on config.backend, returning its own IVectorStore implementation
function wireStore(config: MemoMcpConfig): IVectorStore {
  return new FileVectorStore({ baseDir: config.baseDir, partitionDir: PARTITION_DIR, recordsFile: RECORDS_FILE });
}
