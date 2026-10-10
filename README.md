# mcp-health

CLI and GitHub Action that scans MCP (Model Context Protocol) server configs and reports **broken entries, missing commands, bad URLs, placeholder env vars, unpinned packages, npm drift, and optional initialize probes**.

Catch rotten MCP configs before agents fail on them.

## Install

Node.js 20 or newer.

The npm package name is `@leon-pixel/mcp-health`. The unscoped name `mcp-health` was published by someone else and then unpublished, so npm will not let this project use it. The command name is still `mcp-health`.

From a checkout of this repository:

```bash
npm install
npm run check -- --no-user fixtures/healthy
```

From npm, once a maintainer has published a release (see [Releases](#releases)):

```bash
npm i -g @leon-pixel/mcp-health
mcp-health check .
```

```bash
npx @leon-pixel/mcp-health check .
```

## Usage

```bash
npm run check -- .
npm run check -- --no-user fixtures/issues
npm run check -- --no-user --online fixtures/healthy
npm run check -- --no-user --probe --probe-timeout 5000 fixtures/probe-ok
npm run check -- --no-user --json fixtures/healthy
npm run check -- --no-user -f path/to/mcp.json .
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All ok |
| `1` | Warnings only |
| `2` | Failures |

## GitHub Action

```yaml
name: mcp-health
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: leon-pixel/mcp-health@v1
        with:
          path: .
          args: --no-user
```

`v1` is a moving tag. The [release workflow](.github/workflows/release.yml) points it at the latest stable `v1.x.y` release. It is not on the repository yet: the only tag today is `v1.0.0`, and that commit does not include fixes made after 1.0.0. After `v1.1.0` is tagged, `leon-pixel/mcp-health@v1` tracks the latest 1.x commit. Until that tag exists, pin an immutable release or a commit SHA.

The action is not listed on the GitHub Marketplace. Install it from this repository. Optional args: `--online`, `--probe`, `--probe-timeout 8000`, `--json`.

## What it scans

**Project:** `.cursor/mcp.json`, `mcp.json`, `.mcp.json`, `.vscode/mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`

**User-level** (disable with `--no-user`): `~/.cursor/mcp.json`, `~/.claude/settings.json`, Claude Desktop `claude_desktop_config.json`

## Checks

- Offline: JSON shape, PATH (including Windows `PATHEXT`), URLs, pins, placeholders
- Config variables: `${workspaceFolder}`, `${userHome}`, `${pathSeparator}`, and `${env:NAME}` are expanded. `${input:…}` and anything else still in the config fail the server instead of being reported healthy
- `--online`: npm latest vs the pinned version or semver range (`NPM_DRIFT` only when latest is outside the pin)
- `--probe`: MCP handshake from the project root (stdio spawn, or HTTP POST with the config's headers). Stdio matches the JSON-RPC id and skips logs and notifications. HTTP accepts a JSON body or a Streamable HTTP SSE response. Env values are never printed

The initialize request uses protocol revision `2025-11-25`. If the server rejects that method, the probe tries `server/discover` on `2026-07-28`.

## Example

```text
[FAIL] broken-binary  (stdio)
    - FAIL COMMAND_NOT_FOUND: Command not found on PATH: ...
[WARN] unpinned  (stdio)
    - WARN UNPINNED_PACKAGE: ...
```

## Releases

Pushing a stable tag `vX.Y.Z` that matches `version` in `package.json` runs [`.github/workflows/release.yml`](.github/workflows/release.yml). That workflow:

1. Runs the test suite and build
2. Creates a GitHub Release
3. Moves the major tag (`v1` for a `v1.x.y` release) to that commit
4. Publishes `@leon-pixel/mcp-health` to npm when the repository secret `NPM_TOKEN` is set

`NPM_TOKEN` is an npm automation token that can publish the `@leon-pixel` scope. When the secret is absent, the workflow still cuts the GitHub Release and moves the major tag, and it skips npm publish.

The action is not published to the GitHub Marketplace by this workflow. Marketplace listing is a separate step on the GitHub release page.

## Tradeoffs

- The default scan is offline, so it is safe in CI
- `--probe` runs real processes. Do not point it at configs you do not trust
- IDE `PATH` can differ from the PATH in CI or a terminal
- `${input:…}` values are not prompted. They are reported as unresolved

## Roadmap

See [ROADMAP.md](./ROADMAP.md) and [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
