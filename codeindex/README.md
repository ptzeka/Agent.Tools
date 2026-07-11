# codeindex

Repository vectorizer. Walks a working tree, chunks it semantically, embeds the
chunks (via `@peritze/vectorizer`), and writes them to a local file directory
(via `@peritze/vectorstore`). The output is consumed by [codemcp](../codemcp/),
which serves it to coding assistants over MCP.

Storage is behind the `IVectorStore` / `IGraphStore` / `CommitRepository`
interfaces (see [@peritze/vectorstore](../vectorstore/), [@peritze/graphstore](../graphstore/),
and [src/db/commitRepository.ts](./src/db/commitRepository.ts)); the file
backend is the only implementation today, but a new backend can be added by
implementing those interfaces and wiring it into [src/wiring.ts](./src/wiring.ts)
and the `--backend` choices in [src/cli.ts](./src/cli.ts).

## Build

```bash
cd codeindex
npm install
npm run build      # → dist/cli.js
```

## Commands

Run from the repo root you want indexed (`--root <path>` to index elsewhere):

```bash
# show what would be indexed, no backend writes
node dist/cli.js plan

# apply pending migrations (--status to inspect without applying)
node dist/cli.js migrate

# migrate + chunk + embed + write the current commit (idempotent per commit sha)
node dist/cli.js publish

# ignore the incremental baseline and re-chunk + re-embed every file
node dist/cli.js publish --full
```

Publishing is incremental when it can be: if a previously indexed commit exists
that is HEAD or a git ancestor of HEAD (same embedding model + dim), only the
files that differ from it — committed, staged, unstaged, or untracked — are
re-chunked and re-embedded; everything else is carried over from that snapshot.
Deleted/renamed files have their stale chunks and outgoing edges dropped. After
a successful publish, superseded snapshots on the same branch are pruned so one
snapshot per branch remains. No usable baseline (first publish, model change,
diverged branch, no git) falls back to a full index automatically.

`pack-and-publish` is an alias for `publish`. `clear --repository <owner/name>`
deletes a repository's indexed data (commits, chunks, edges).

### Global flags

| Flag | Default | Notes |
|---|---|---|
| `-r, --root <path>` | `cwd` | Directory to walk. Config defaults to `<root>/codeindex.config.json`. |
| `-c, --config <path>` | `<root>/codeindex.config.json` | Optional; only `excludeGlobs` lives here. |
| `-b, --backend <file>` | `file` | Storage backend. Always writes `codeindex/data/` (cwd-independent, no flag). |
| `--branch <name>` | `main` | Branch recorded on the commit row. |
| `--repository <name>` | auto-detect | `owner/repo` from `origin`, else the resolved absolute root path. Scopes multi-repo backends with `branch`. |
| `--embed-provider <local\|voyage\|openai>` | `local` | `local` is an offline hashed bag-of-tokens (dev only); `voyage`/`openai` read `VOYAGE_API_KEY` / `OPENAI_API_KEY` from env. |
| `--embed-dim <n>` | `768` | Must match the dimensionality of the stored chunks. |

## See also

- [codemcp](../codemcp/) — the MCP server that reads what codeindex writes.
- [migrations/001_init.sql](./migrations/001_init.sql) — the `commits` bookkeeping schema.
- [codeindex.config.example.json](./codeindex.config.example.json) — config-file template.
