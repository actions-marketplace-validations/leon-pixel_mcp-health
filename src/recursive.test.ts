import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { discoverConfigPaths, __testing } from "./discover.js";
import { runCheck } from "./run.js";
import { exitCode, formatHuman } from "./report.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const tsx = join(repo, "node_modules", ".bin", "tsx");

function writeJson(root: string, rel: string, value: unknown): string {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(value, null, 2)}\n`);
  return full;
}

function cursorConfig(name: string, command: string): unknown {
  return { mcpServers: { [name]: { command, args: ["--version"] } } };
}

function vscodeConfig(name: string, command: string): unknown {
  return { servers: { [name]: { command, args: ["--version"] } } };
}

describe("recursive project discovery", () => {
  it("leaves nested configs undiscovered until --recursive", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-nested-"));
    const outside = mkdtempSync(join(tmpdir(), "mcp-health-outside-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const api = writeJson(
      root,
      "services/api/.cursor/mcp.json",
      cursorConfig("api-server", "definitely-not-a-real-mcp-binary-xyz"),
    );
    const web = writeJson(
      root,
      "apps/web/.vscode/mcp.json",
      vscodeConfig("web-server", "node"),
    );
    const decoy = writeJson(
      root,
      "node_modules/decoy/.cursor/mcp.json",
      cursorConfig("decoy-server", "definitely-not-a-real-mcp-binary-xyz"),
    );
    writeJson(outside, ".cursor/mcp.json", cursorConfig("outside-server", "node"));
    symlinkSync(outside, join(root, "linked"), "dir");
    const before = [api, web, decoy].map((file) => readFileSync(file));

    try {
      expect(
        discoverConfigPaths(root, { includeUserConfig: false }).some((file) =>
          file.startsWith(root),
        ),
      ).toBe(false);

      const plain = await runCheck({ root, includeUserConfig: false });
      expect(plain.servers.map((server) => server.findings[0]?.code)).toEqual(["NO_CONFIG"]);
      expect(exitCode(plain)).toBe(1);
      expect(plain.summary).toMatchObject({ files: 0, servers: 0, warn: 0, fail: 0 });
      expect(formatHuman(plain)).not.toContain("api-server");
      expect(formatHuman(plain)).not.toContain("decoy-server");
      expect(formatHuman(plain)).not.toContain("outside-server");

      const allowed = await runCheck({
        root,
        includeUserConfig: false,
        allowMissing: true,
        recursive: true,
      });
      expect(allowed.servers.some((server) => server.name === "api-server")).toBe(true);
      expect(exitCode(allowed)).toBe(2);

      const empty = mkdtempSync(join(tmpdir(), "mcp-health-empty-recursive-"));
      try {
        const missing = await runCheck({
          root: empty,
          includeUserConfig: false,
          recursive: true,
        });
        expect(missing.servers[0]?.findings[0]?.code).toBe("NO_CONFIG");
        expect(exitCode(missing)).toBe(1);
        const quiet = await runCheck({
          root: empty,
          includeUserConfig: false,
          recursive: true,
          allowMissing: true,
        });
        expect(quiet.servers[0]?.findings[0]?.code).toBe("NO_CONFIG");
        expect(exitCode(quiet)).toBe(0);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }

      expect([api, web, decoy].map((file) => readFileSync(file))).toEqual(before);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports both nested packages, skips ignored directories, and keeps the worst exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-recursive-"));
    const outside = mkdtempSync(join(tmpdir(), "mcp-health-recursive-out-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const api = writeJson(
      root,
      "services/api/.cursor/mcp.json",
      cursorConfig("api-server", "definitely-not-a-real-mcp-binary-xyz"),
    );
    const web = writeJson(
      root,
      "apps/web/.vscode/mcp.json",
      vscodeConfig("web-server", "node"),
    );
    const decoy = writeJson(
      root,
      "node_modules/decoy/.cursor/mcp.json",
      cursorConfig("decoy-server", "definitely-not-a-real-mcp-binary-xyz"),
    );
    for (const name of __testing.SKIP_DIR_NAMES) {
      if (name === "node_modules") continue;
      writeJson(
        root,
        `${name}/pkg/mcp.json`,
        cursorConfig(`hidden-${name}`, "definitely-not-a-real-mcp-binary-xyz"),
      );
    }
    writeJson(outside, "pkg/mcp.json", cursorConfig("outside-server", "node"));
    symlinkSync(outside, join(root, "linked"), "dir");
    const before = [api, web, decoy].map((file) => readFileSync(file));

    try {
      const report = await runCheck({ root, includeUserConfig: false, recursive: true });
      const names = report.servers.map((server) => server.name).sort();
      expect(names).toEqual(["api-server", "web-server"]);
      expect(report.files).toEqual(
        [api, web].sort(),
      );
      expect(report.servers.every((server) => server.scope === "project")).toBe(true);
      expect(report.servers.find((server) => server.name === "api-server")?.status).toBe(
        "fail",
      );
      expect(report.servers.find((server) => server.name === "web-server")?.status).toBe(
        "ok",
      );
      expect(report.summary).toMatchObject({
        files: 2,
        servers: 2,
        ok: 1,
        warn: 0,
        fail: 1,
      });
      expect(exitCode(report)).toBe(2);
      const text = formatHuman(report);
      expect(text).toContain("project");
      expect(text).toContain("api-server");
      expect(text).toContain("web-server");
      expect(text).not.toContain("decoy-server");
      expect(text).not.toContain("outside-server");
      expect(text).not.toContain("hidden-");
      expect(report.files.some((file) => file.includes("node_modules"))).toBe(false);
      expect(report.files.some((file) => file.includes(`${join("linked", "pkg")}`))).toBe(
        false,
      );
      expect([api, web, decoy].map((file) => readFileSync(file))).toEqual(before);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads user configs once and still skips them with --no-user", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-recursive-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-recursive-home-"));
    const userFile = writeJson(home, ".cursor/mcp.json", cursorConfig("from-user", "node"));
    writeJson(
      root,
      "services/api/.cursor/mcp.json",
      cursorConfig("api-server", "node"),
    );
    writeJson(root, "apps/web/.vscode/mcp.json", vscodeConfig("web-server", "node"));
    const locate = {
      home,
      platform: "linux" as const,
      env: { PATH: process.env.PATH },
    };

    try {
      const once = await runCheck({
        root,
        recursive: true,
        includeUserConfig: true,
        ...locate,
      });
      expect(once.files.filter((file) => file === userFile)).toEqual([userFile]);
      expect(once.servers.map((server) => server.name).sort()).toEqual([
        "api-server",
        "from-user",
        "web-server",
      ]);
      expect(once.servers.find((server) => server.name === "from-user")?.scope).toBe("user");
      expect(once.servers.find((server) => server.name === "api-server")?.scope).toBe(
        "project",
      );
      expect(once.summary.servers).toBe(3);
      expect(exitCode(once)).toBe(0);

      const hidden = await runCheck({
        root,
        recursive: true,
        includeUserConfig: false,
        ...locate,
      });
      expect(hidden.files).not.toContain(userFile);
      expect(hidden.servers.map((server) => server.name)).not.toContain("from-user");

      const shallow = await runCheck({
        root,
        includeUserConfig: true,
        ...locate,
      });
      expect(shallow.files).toEqual([userFile]);
      expect(shallow.servers.map((server) => server.name)).toEqual(["from-user"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("stops at the depth limit, dedupes an inside symlink, and does not loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-depth-"));
    const depth = __testing.MAX_RECURSIVE_DEPTH;
    const keptParts = Array.from({ length: depth }, (_, index) => `d${index + 1}`);
    const kept = writeJson(
      root,
      join(...keptParts, "mcp.json"),
      cursorConfig("kept-server", "node"),
    );
    const dropped = writeJson(
      root,
      join(...keptParts, "too-deep", "mcp.json"),
      cursorConfig("dropped-server", "definitely-not-a-real-mcp-binary-xyz"),
    );
    writeJson(root, "services/api/.cursor/mcp.json", cursorConfig("api-server", "node"));
    symlinkSync(join(root, "services", "api"), join(root, "alias"), "dir");
    symlinkSync(root, join(root, "loop"), "dir");

    try {
      expect(__testing.MAX_RECURSIVE_DEPTH).toBe(8);
      const found = discoverConfigPaths(root, { includeUserConfig: false, recursive: true });
      expect(found).toContain(kept);
      expect(found).not.toContain(dropped);
      const apiReal = realpathSync(join(root, "services/api/.cursor/mcp.json"));
      expect(
        found.filter((file) => {
          try {
            return realpathSync(file) === apiReal;
          } catch {
            return false;
          }
        }),
      ).toHaveLength(1);
      const report = await runCheck({ root, includeUserConfig: false, recursive: true });
      expect(report.servers.map((server) => server.name).sort()).toEqual([
        "api-server",
        "kept-server",
      ]);
      expect(exitCode(report)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wires --recursive through the CLI and documents the action args example", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-recursive-cli-"));
    writeJson(
      root,
      "services/api/.cursor/mcp.json",
      cursorConfig("api-server", "definitely-not-a-real-mcp-binary-xyz"),
    );
    writeJson(root, "apps/web/.vscode/mcp.json", vscodeConfig("web-server", "node"));
    writeJson(
      root,
      "node_modules/decoy/.cursor/mcp.json",
      cursorConfig("decoy-server", "node"),
    );
    const readme = readFileSync(join(repo, "README.md"), "utf8");
    const action = readFileSync(join(repo, "action.yml"), "utf8");

    try {
      const help = spawnSync(tsx, [join(repo, "src", "cli.ts"), "check", "--help"], {
        encoding: "utf8",
      });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("--recursive");
      expect(help.stdout).toContain("node_modules");

      const nested = spawnSync(
        tsx,
        [join(repo, "src", "cli.ts"), "check", "--no-user", "--recursive", "--json", root],
        { encoding: "utf8" },
      );
      expect(nested.status).toBe(2);
      expect(nested.stdout).toContain("api-server");
      expect(nested.stdout).toContain("web-server");
      expect(nested.stdout).not.toContain("decoy-server");

      const shallow = spawnSync(
        tsx,
        [join(repo, "src", "cli.ts"), "check", "--no-user", "--json", root],
        { encoding: "utf8" },
      );
      expect(shallow.status).toBe(1);
      expect(shallow.stdout).toContain("NO_CONFIG");
      expect(shallow.stdout).not.toContain("api-server");

      expect(readme).toContain("--recursive");
      expect(readme).toContain("args: --recursive");
      expect(readme).toContain("path: services/api");
      expect(readme).toContain("args: --probe");
      expect(action).not.toMatch(/^ {2}recursive:/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
