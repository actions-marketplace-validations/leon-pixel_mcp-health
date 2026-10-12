# Roadmap

## Product promise

`mcp-health` is the local and CI check that answers: **will my MCP servers actually load, or will agents fail on a broken config?**

It is not a registry UI and not a hosted dashboard. It is a config scan plus an optional handshake.

## Shipped in 1.0.0

| # | Capability | Status |
|---|------------|--------|
| 1 | Static config scan | Shipped |
| 2 | Client path matrix (Cursor, VS Code, Claude Code, Claude Desktop) | Shipped |
| 3 | npm registry version drift (`--online`) | Shipped |
| 4 | Optional smoke probe (`--probe`) | Shipped |
| 5 | Reusable GitHub Action | Shipped. Listed as [mcp-health-doctor](https://github.com/marketplace/actions/mcp-health-doctor) |
| 6 | Release workflow | Shipped. `@leon-pixel/mcp-health` is on npm |
| 7 | Docs and changelog | Shipped |

0.1.0 through 1.0.0 were cut on the same day as the initial public commits. See the changelog.

## Shipped in 1.2.0

| # | Capability | Status |
|---|------------|--------|
| 1 | `tools/list` during `--probe`, with `EMPTY_TOOLS` as a warning | Shipped |
| 2 | Windsurf, Zed, and Codex project and user config paths | Shipped |
| 3 | SARIF 2.1.0 and GitHub Actions annotations | Shipped. Code scanning upload is opt-in |
| 4 | README demo and a comparison with Inspector, MCP Doctor, and mcp-healthcheck | Shipped |

## Shipped in 1.2.1

Patch release on top of the published 1.2.0 package. IDE input variables and disabled servers no longer fail a scan. OAuth remotes, JSONC configs, Codex auth env vars, and Zed extension servers are recognized. The Action ignores a repository with no MCP config unless asked not to. Node 22.12 is the minimum.

## Next

1.2.1 is published. npm `latest` and the `v1` Action tag track that release. Nothing is waiting on a tag.

Still open, in the order a first-time user hits them:

1. Claude Code user and per-project servers live in `~/.claude.json`, which is not scanned (#41).
2. Continue (`.continue/mcpServers` and `config.yaml`, #42), Junie (`.junie/mcp/mcp.json`, #43), and Cline (`~/.cline/data/settings/cline_mcp_settings.json`, #44).
3. An empty server map exits 1 while the summary line says `warn: 0` (#45).
4. `--probe-timeout foo` fails the probe immediately instead of rejecting the flag (#46).
5. The Windows MSIX Claude Desktop config path (#47).

## Out of scope

Hosted dashboard, auto-fix that rewrites configs, registry browser, paid cloud.
