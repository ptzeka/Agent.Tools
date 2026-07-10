import type { DbConnectionFactory, IVectorStore } from '@peritze/vectorstore';
import type { IGraphStore } from '@peritze/graphstore';
import type { CommitRepository } from '../db/commitRepository.js';

export interface ClearDeps {
  repository: string;
  vectorStore: IVectorStore;
  graphStore: IGraphStore;
  factory: DbConnectionFactory;
  repo: CommitRepository;
  log?: (msg: string) => void;
}

export interface ClearResult {
  repository: string;
  commitCount: number;
  commitShas: string[];
}

// deletes every commit snapshot (chunks + edges + commit row) for one repository, across
// both backends: vectorStore/graphStore are namespaced by commit sha, so each sha found under
// `repository` is cleared individually before the commit rows themselves are dropped.
export async function clearRepository(deps: ClearDeps): Promise<ClearResult> {
  const { repository, vectorStore, graphStore, factory, repo } = deps;
  const log = deps.log ?? (() => undefined);

  await using conn = await factory.getConnection();
  const commitShas = await repo.listCommitShas(conn, repository);
  for (const sha of commitShas) {
    log(`deleting commit ${sha}`);
    await vectorStore.deleteNamespace(sha);
    await graphStore.deleteNamespace(sha);
  }
  await repo.deleteCommits(conn, repository);

  return { repository, commitCount: commitShas.length, commitShas };
}
