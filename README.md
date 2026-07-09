# agent.tools

Standalone MCP servers and AI-agent tooling, organized as an npm-workspaces monorepo.

## Packages

| Workspace | Purpose |
| --- | --- |
| [codemcp](codemcp/) | Stdio MCP server for code search — serves published code indexes to coding assistants (Claude Code, Cursor). |
| [memomcp](memomcp/) | Stdio MCP server for agent memory — remember/recall over core + archival memories with vector search. |
| [codeindex](codeindex/) | Repo indexer/publisher — chunks a repository (tree-sitter AST for TS/JS, regex fallback), embeds chunks, publishes per-commit snapshots. |
| [mcp-tool-server](mcp-tool-server/) | Shared MCP server plumbing used by the servers above. |
| [vectorizer](vectorizer/) | Embedding tier — turns text chunks into vectors. |
| [vectorstore](vectorstore/) | Vector storage tier — file-backed and Postgres-backed stores. |
| [graphstore](graphstore/) | Relationship storage tier — typed code edges (imports/calls/implements/extends) with file and Postgres backends. |

## Quick start

Requires Node.js >= 20.

```bash
npm install
npm run build
npm test
```

## Installation & MCP registration

See [INSTALL.md](INSTALL.md) for the full setup: build → index → link → register → verify, plus a usage guide for each server's MCP tools.

[mcpServers.json](mcpServers.json) is the repo-scoped MCP registration template (launches the servers via `npx @peritze/...` with cwd = this repo).

## Scripts

- `npm run build` / `npm test` / `npm run clean` — run across all workspaces
- `npm run link:cli` — link `codemcp`, `codeindex`, `memomcp` bin shims globally
- `npm run index:publish` / `npm run index:clear` — publish or clear code-index snapshots ([scripts/](scripts/))
- `npm run verify` — end-to-end setup check (built → linked → indexed → probes answer)
