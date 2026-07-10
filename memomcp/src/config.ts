import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EmbedProvider } from '@peritze/vectorizer';

// the file backend is the only implementation today; a future SQL-backed store adds its id here
export type Backend = 'file';

// CLI flags + an optional config file resolved from cwd, no env fallbacks
export interface MemoMcpConfig {
  backend: Backend;
  embedProvider: EmbedProvider;
  embedDim: number;
  // collection used when a tool call omits `collection`; an opaque partition id (user/session/topic)
  defaultCollection: string;
  // file-backend root holding memories/<collection>/records.jsonl
  baseDir: string;
}

export interface CliOverrides {
  backend?: Backend;
  embedProvider?: EmbedProvider;
  embedDim?: number;
  defaultCollection?: string;
  baseDir?: string;
}

const DEFAULTS = {
  backend: 'file' as Backend,
  // paraphrase recall needs a real model; local hashed bag-of-words can't do it (BACKLOG M3-7)
  embedProvider: 'voyage' as EmbedProvider,
  embedDim: 1024,
  defaultCollection: 'default',
};

export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultBaseDir(): string {
  return resolve(packageRoot(), 'data');
}

export function loadConfig(overrides: CliOverrides = {}): MemoMcpConfig {
  const cwd = process.cwd();
  return {
    backend: overrides.backend ?? DEFAULTS.backend,
    embedProvider: overrides.embedProvider ?? DEFAULTS.embedProvider,
    embedDim: overrides.embedDim ?? DEFAULTS.embedDim,
    defaultCollection: overrides.defaultCollection ?? DEFAULTS.defaultCollection,
    baseDir: overrides.baseDir ? resolve(cwd, overrides.baseDir) : defaultBaseDir(),
  };
}
