# INSTALL — codemcp + memomcp

Everything required for the two MCP servers in this repo to work in Claude Code /
Cursor: all workspaces built, the repo indexed, the CLIs linked globally, the
servers registered, and verified end-to-end.

- **codemcp** — code search MCP server. Serves the index snapshots that
  **codeindex** publishes (chunking via tree-sitter AST for TS/JS/C#, regex
  fallback; embeddings; a per-commit relationship graph).
- **memomcp** — agent memory MCP server. remember/recall over core + archival
  memories backed by the shared vector store.

The order matters: **build → index → link → register → verify**.

## 1. Build everything

```bash
npm install
npm run build
npm test          # all workspace suites must pass
```

Working means: `codeindex/dist/cli.js`, `codemcp/dist/server.js`, and
`memomcp/dist/server.js` exist, tests pass, and the tree-sitter prebuilds
installed **without compiling** (no Python/C++ toolchain — `tree-sitter` is
pinned to a version that ships `prebuilds/` for darwin/linux/win32).

## 2. Index this repository (codemcp only)

codemcp has nothing to serve until codeindex publishes at least one snapshot:

```bash
cd codeindex && npm run publish:file
```

The layout is repo-first: confirm `codeindex/data/<owner>/<repo>/schema_versions.json`
and `codeindex/data/<owner>/<repo>/commits/<sha>/` exist, the latter holding
`chunks.jsonl` + `commit.json` + `edges.jsonl` (the relationship graph). codemcp
auto-discovers every `<owner>/<repo>/` subtree under `codeindex/data/`.

To index a **different** repository, run codeindex from that repo's root (or pass
`--root <path>`) — see `codeindex --help` and
[codeindex.config.example.json](codeindex/codeindex.config.example.json).

To wipe stale snapshots: delete the `codeindex/data/<owner>/<repo>/` subtree for
the repository you no longer want served. (The `scripts/clear-codeindex.*`
helpers predate the repo-first layout — don't rely on them until updated.)

memomcp needs no indexing step; its file backend creates
`memomcp/data/memories/<collection>/records.jsonl` on first `remember`.

## 3. Link the CLI commands globally

`npm link` puts `codemcp`, `codeindex`, and `memomcp` bin shims into the global
npm prefix (on the PATH), pointing at this checkout — so the commands run from
any directory and a rebuild updates them in place (no re-link needed):

```bash
npm run link:cli
```

Verify with `npm ls -g @peritze/codemcp @peritze/codeindex @peritze/memomcp` —
**and check the links resolve to THIS checkout**, not an older one. To detach
(e.g. before linking a different checkout): `npm run unlink:cli`.

Invocation forms (npm ≥7 npx does NOT fall back to global installs — it resolves
the local `node_modules`, then the registry):

- cwd inside this checkout → `npx @peritze/codemcp ...` (workspace resolution).
  Always the scoped name, never bare `npx codemcp` — an unrelated `codemcp`
  package exists on the public registry, and the scope makes npx fail loudly
  instead of fetching it.
- any other cwd → the bare shims: `codemcp ...`, `codeindex ...`, `memomcp ...`.

## 4. Register the MCP servers in the global configs

Add `codemcp` and `memomcp` entries under `mcpServers` in each target,
**preserving every other key**. Global configs launch servers from whatever
project is open, so they must use the linked shims — no absolute paths, no npx.
([mcpServers.json](mcpServers.json) is the repo-scoped template; it uses
`npx @peritze/...` because it always launches with cwd = this repo.)

| Target | File |
| --- | --- |
| Claude Code | `~/.claude/mcp.json` if present, else top-level `mcpServers` in `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |

```json
"codemcp": {
  "type": "stdio",
  "command": "codemcp",
  "args": ["--backend", "file"]
},
"memomcp": {
  "type": "stdio",
  "command": "memomcp",
  "args": ["--backend", "file", "--embed-provider", "local"]
}
```

If a host can't spawn `.cmd` shims on Windows, fall back to
`"command": "cmd", "args": ["/c", "codemcp", "--backend", "file"]`.

Restart Claude Code / Cursor afterwards so the host respawns the servers; the
tools then appear as `mcp__codemcp__*` and `mcp__memomcp__*`.

## 5. Verify end-to-end

Work top-down; stop at the first failure — it names the step to redo.

1. **Registered?** the `codemcp` and `memomcp` keys exist in the target config
   as `"command": "codemcp"` / `"command": "memomcp"` (global configs; the repo
   `mcpServers.json` uses the npx form).
2. **Linked?** `npm ls -g @peritze/codemcp @peritze/codeindex @peritze/memomcp` —
   the links must point at THIS checkout (and `dist/` must exist, i.e. built).
3. **Indexed?** `ls codeindex/data/<owner>/<repo>/schema_versions.json codeindex/data/<owner>/<repo>/commits`
4. **Answers standalone?** (from any cwd, proving the global shims)

   ```bash
   codemcp --backend file probe list_commits '{}'
   memomcp --backend file --embed-provider local probe recall '{"query":"anything"}'
   ```

5. **Answers live?** after a host restart:
   - `mcp__codemcp__list_commits` must list the snapshot published in step 2;
     then `mcp__codemcp__get_symbol {"name":"wireParser"}` must return that
     function's line-precise chunk from codeindex/src/wiring.ts, and
     `mcp__codemcp__get_relationships {"name":"IParser","direction":"in"}` must
     list its implementers and importers from the edge graph.
   - `mcp__memomcp__remember {"content":"install smoke test"}` then
     `mcp__memomcp__recall {"query":"smoke test"}` must return it.

## Using the tools

Every tool is callable two ways: live from a host as `mcp__<server>__<tool>`, or
from the command line via `probe` (`codemcp --backend file probe <tool> '<json>'`)
for debugging. `codemcp tools` / `memomcp tools` print the full schemas.

### codemcp — code search

Two-tier flow: **locate** (cheap, content-free summaries) → **expand** (full
chunk bodies for the ids you pick). Use the `search_*`/`get_*` forms when you
want bodies immediately.

| Tool | Use it to |
| --- | --- |
| `search_code` | Semantic search over chunk content — "where is retry handled?" |
| `locate_code` / `expand_chunk` | Same search, but scan summaries first, then expand only the chunks you need |
| `get_symbol` / `locate_symbol` | Fetch a function/class/interface by name, line-precise |
| `get_file_context` / `locate_file` | Everything indexed for one file path |
| `get_relationships` | Edge graph: who implements/imports/calls a symbol (`direction: in\|out`) |
| `related_code` | Chunks structurally related to a given chunk |
| `list_commits` | Which snapshots (repos + SHAs) the server is serving |

### memomcp — agent memory

Memories have a `kind`: **core** (always returned by every recall) and
**archival** (retrieved top-k by similarity). `collection` partitions stores
(user/session/topic); `category`/`tenant` are filterable dimensions.

| Tool | Use it to |
| --- | --- |
| `remember` | Store a memory; pass `id` to overwrite (upsert) |
| `recall` | All core memories + top-k archival ranked against `query` (`rank: true` re-ranks by reranker score) |
| `recall_locate` / `recall_expand` | Two-tier recall: scan content-free summaries, then read only the bodies you want |
