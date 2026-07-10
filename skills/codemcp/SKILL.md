---
name: codemcp
description: Operate codemcp end-to-end as an AI agent — (re)index a repository with codeindex, validate the codemcp MCP server is running and serving that index, and pick the right retrieval tool (locate vs expand tiers). Use when asked to index/reindex a repo, when codemcp tools are missing or return "(no indexed commits)" / "(no results)" unexpectedly, or before relying on the index after a large change.
---

# codemcp: index a repository & validate the server

The `codeindex`, `codemcp`, and `memomcp` CLIs are globally npm-linked bare
shims — they run from **any** cwd and always resolve to the linked agent.tools
checkout. Never invoke them via `npx`: the `@peritze/*` packages are not
published to a registry, so `npx @peritze/codeindex` 404s from any cwd outside
that checkout (and bare `npx codeindex` would fetch an unrelated public
package). If a shim is missing (`npm ls -g @peritze/codeindex` fails), it must
be linked from the agent.tools checkout: `npm install && npm run build &&
npm run link:cli` there — see that repo's INSTALL.md.

## Index a repository

1. Confirm the shim is linked: `npm ls -g @peritze/codeindex` succeeds.
2. Publish a snapshot of the current commit — from any cwd:
   ```bash
   codeindex --backend file publish --root <REPO_ROOT> [--repository <owner/name>] [--branch <name>]
   ```
   `<REPO_ROOT>` is the root of the repository being indexed (usually the cwd's
   repo root). Publish does NOT pre-clean: re-publishing a commit sha that
   already has a snapshot appends to its `chunks.jsonl`. To re-publish cleanly,
   clear that repository first (see below), then publish.
3. The publish output echoes `commitSha`, `fileCount`, `chunkCount`,
   `edgeCount` — treat a publish without that JSON as failed.
4. Reindexing after new commits is the same command; the layout is repo-first,
   so each commit sha gets its own snapshot.

Notes:
- The index is per-commit: query results always carry the sha they came from.
  If `resolveCommit` complains about multiple snapshots, pass `commit`
  explicitly.
- `repository` ids are full ids (e.g. `owner/name`, or the registered
  multi-repo name) — never the bare repo folder name. When unsure, call
  `list_commits` first and copy the `repository=` value it prints.
- To delete a repository's indexed data (commits, chunks, edges), use
  codeindex's own `clear` command — works from any cwd and refuses to guess
  the target:
  ```bash
  codeindex --repository <owner/name> clear --yes
  ```
- A checksum-mismatch error from the migration journal means the repository's
  `schema_versions.json` predates a changed migration; the store is
  disposable, but `codeindex clear` is NOT enough — it deletes commits yet
  leaves `schema_versions.json` in place, so publish still fails. Delete the
  repository's whole subtree under the codeindex data dir
  (`<agent.tools checkout>/codeindex/data/<owner>/<repo>/`) and republish.

## Validate the MCP server is running

Work top-down; the first failing check names the fix.

1. **Registered?** the `codemcp` key exists in the global MCP config
   (`~/.claude.json`) as `"command": "codemcp"` — the globally-linked shim,
   never an npx form or an absolute path.
2. **Linked?** `npm ls -g @peritze/codemcp` — missing means link from the
   agent.tools checkout (see top of this file).
3. **Indexed & answers standalone?** (bypasses the host entirely; works from
   any cwd)
   ```bash
   codemcp --backend file probe list_commits '{}'
   ```
   The target repository must appear with the expected commit sha — missing or
   stale means run the indexing section above. A non-zero exit or an error
   means the server itself is broken; `codemcp tools` lists valid tool names.
4. **Answers live?** call `mcp__codemcp__list_commits` in the session — it must
   show the snapshot you just published (matching sha). Tools absent → the host
   needs a restart or the registration is malformed.

## Choosing a retrieval tool

- Know the exact name → `get_symbol` (bodies) or `locate_symbol` (outline only).
- Who calls / imports / implements / extends X → `get_relationships` (edge graph;
  pass a symbol name, `path#Class.method` id, or file path; filter with
  `type`/`direction`). Vector tools cannot answer these questions.
- Searching by meaning → `locate_code` first (content-free summaries), then
  `expand_chunk` on the `[path:start-end]` citations worth reading; `search_code`
  when you want bodies in one call.
- Understanding a file → `locate_file` for its symbol outline, `get_file_context`
  for everything including governing CLAUDE.md files.
- "More like this chunk" → `related_code` with the seed's citation.
- Class methods are indexed as their own chunks (`kind=method`,
  `parentSymbol=<class>`), so prefer querying the method name over the class name.
