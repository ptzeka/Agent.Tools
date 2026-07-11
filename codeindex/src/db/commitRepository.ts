// Snapshot/commit bookkeeping + migration journal, backend-agnostic. The file backend is the
// only implementation today (see db/file/fileRepository.ts); a future SQL-backed implementation
// plugs in here without changing this contract or its callers (migrate.ts, publish.ts, clear.ts).

import type { DbConnection } from './types.js';
import type { CommitRow } from '../types.js';

export interface AppliedMigration {
  scriptName: string;
  checksum: string;
}

export interface CommitRepository {
  ensureSchemaVersionsTable(conn: DbConnection): Promise<void>;
  getAppliedMigrations(conn: DbConnection): Promise<AppliedMigration[]>;
  recordMigration(conn: DbConnection, scriptName: string, checksum: string): Promise<void>;

  acquireAdvisoryLock(conn: DbConnection, key: number): Promise<void>;
  releaseAdvisoryLock(conn: DbConnection, key: number): Promise<void>;

  upsertCommit(conn: DbConnection, commit: CommitRow): Promise<void>;

  listCommitShas(conn: DbConnection, repository: string): Promise<string[]>;
  // the stored row for one snapshot, or null when the sha was never indexed; the incremental
  // publisher reads branch/embedModel/embedDim/indexedAt off this to pick a diff baseline
  getCommit(conn: DbConnection, commitSha: string): Promise<CommitRow | null>;
  // drops one snapshot's commit row (chunks/edges are the stores' to delete, not this repo's)
  deleteCommit(conn: DbConnection, commitSha: string): Promise<void>;
  deleteCommits(conn: DbConnection, repository: string): Promise<void>;
}
