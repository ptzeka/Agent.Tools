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
npm run index:publish        # from the repo root (wraps codeindex publish:file)
```

The layout is repo-first: confirm `codeindex/data/<owner>/<repo>/schema_versions.json`
and `codeindex/data/<owner>/<repo>/commits/<sha>/` exist, the latter holding
`chunks.jsonl` + `commit.json` + `edges.jsonl` (the relationship graph). codemcp
auto-discovers every `<owner>/<repo>/` subtree under `codeindex/data/`.

To index a **different** repository, pass its root:
`npm run index:publish -- --root <path> [--branch <name>]` — see
`codeindex --help` and
[codeindex.config.example.json](codeindex/codeindex.config.example.json).

To wipe stale snapshots: `npm run index:clear` (add `-- --repo <owner>/<name>`
to clear one repository, `-- --yes` to skip the prompt) — operates directly on
`codeindex/data/`. From any cwd, use codeindex's own `clear` command instead:
`codeindex --repository <owner/name> clear [--yes]` (deletes that repository's
commits, chunks, and edges; refuses to run without `--repository`).

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

```bash
npm run verify
```

[scripts/verify.mjs](scripts/verify.mjs) checks steps 1–4 below in dependency
order and stops at the first failure — it names the step to redo. The manual
equivalents, plus the live check it cannot script:

1. **Built?** `codeindex/dist/cli.js`, `codemcp/dist/server.js`, and
   `memomcp/dist/server.js` exist.
2. **Linked?** `npm ls -g @peritze/codemcp @peritze/codeindex @peritze/memomcp` —
   the links must point at THIS checkout.
3. **Indexed?** `ls codeindex/data/<owner>/<repo>/schema_versions.json codeindex/data/<owner>/<repo>/commits`
4. **Answers standalone?** (from any cwd, proving the global shims)

   ```bash
   codemcp --backend file probe list_commits '{}'
   memomcp --backend file --embed-provider local probe recall '{"query":"anything"}'
   ```

5. **Answers live?** (manual — needs the MCP host) after a host restart, and
   after confirming the `codemcp`/`memomcp` keys exist in the target config as
   `"command": "codemcp"` / `"command": "memomcp"`:
   - `mcp__codemcp__list_commits` must list the snapshot published in step 2;
     then `mcp__codemcp__get_symbol {"name":"wireParser"}` must return that
     function's line-precise chunk from codeindex/src/wiring.ts, and
     `mcp__codemcp__get_relationships {"name":"IParser","direction":"in"}` must
     list its implementers and importers from the edge graph.
   - `mcp__memomcp__remember {"content":"install smoke test"}` then
     `mcp__memomcp__recall {"query":"smoke test"}` must return it.

## 6. Install the codemcp agent skill globally

[skills/codemcp/SKILL.md](skills/codemcp/SKILL.md) teaches an agent to (re)index a
repo, validate the server, and pick the right retrieval tool. It lives outside
`.claude/skills/`, so no host picks it up automatically — link it into the
**global** skills directory (`~/.claude/skills/`) so it is available in every
project, and updates to this checkout apply without re-copying:

```powershell
# Windows (junction — no admin rights needed); run from the repo root
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\codemcp" -Target "$PWD\skills\codemcp"
```

```bash
# macOS / Linux; run from the repo root
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/codemcp" ~/.claude/skills/codemcp
```

(If you prefer a detached copy over a link: `cp -r skills/codemcp ~/.claude/skills/`.)

Verify: a new Claude Code session lists `codemcp` among available skills, and
`/codemcp` invokes it.

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
