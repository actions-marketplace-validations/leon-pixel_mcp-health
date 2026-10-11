import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { minVersion, satisfies } from "semver";
import { describe, expect, it } from "vitest";
import { changelogSection } from "../scripts/changelog-section.mjs";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

describe("cli paths", () => {
  const tsx = join(repo, "node_modules", ".bin", "tsx");

  it("resolves a relative -f path from cwd, not the scan root", () => {
    const base = mkdtempSync(join(tmpdir(), "mcp-health-rel-"));
    const cwd = join(base, "cwd");
    const root = join(base, "root");
    mkdirSync(cwd);
    mkdirSync(root);
    try {
      writeFileSync(
        join(cwd, "mcp.json"),
        JSON.stringify({
          mcpServers: { local: { command: "node", args: ["--version"] } },
        }),
      );
      const result = spawnSync(
        tsx,
        [join(repo, "src", "cli.ts"), "check", "--no-user", "-f", "mcp.json", root],
        { encoding: "utf8", cwd },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("HEALTHY");
      expect(result.stdout).not.toContain("FILE_NOT_FOUND");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("changelogSection", () => {
  it("returns only the requested version", () => {
    const markdown = [
      "# Changelog",
      "",
      "## [1.2.1] - 2026-10-10",
      "",
      "Patch notes.",
      "",
      "## [1.2.0] - 2026-10-10",
      "",
      "Older notes.",
      "",
    ].join("\n");
    const section = changelogSection(markdown, "1.2.1");
    expect(section).toContain("Patch notes.");
    expect(section).not.toContain("Older notes.");
    expect(section.startsWith("## [1.2.1]")).toBe(true);
  });
});

describe("engines", () => {
  it("declares a Node range that satisfies commander", () => {
    const ours = require("../package.json") as { engines: { node: string } };
    const commander = JSON.parse(
      readFileSync(join(repo, "node_modules", "commander", "package.json"), "utf8"),
    ) as { engines: { node: string } };
    const minimum = minVersion(ours.engines.node);
    expect(minimum).toBeTruthy();
    expect(satisfies(minimum!, commander.engines.node)).toBe(true);
    expect(satisfies("20.19.0", commander.engines.node)).toBe(false);
  });
});
