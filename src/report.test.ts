import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCheck } from "./run.js";
import { exitCode, formatHuman, formatJson } from "./report.js";

const SUMMARY_KEYS = [
  "configWarnings",
  "fail",
  "files",
  "ok",
  "servers",
  "skipped",
  "warn",
];

describe("zero-config check", () => {
  it("names a project file and --allow-missing, and still exits 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-noconfig-"));
    try {
      const warned = await runCheck({ root: dir, includeUserConfig: false });
      const message = warned.servers[0]?.findings[0]?.message ?? "";
      expect(warned.servers[0]?.findings[0]?.code).toBe("NO_CONFIG");
      expect(message).toContain(".cursor/mcp.json");
      expect(message).toContain(".vscode/mcp.json");
      expect(message).toContain("--allow-missing");
      expect(formatHuman(warned)).toContain(message);
      expect(warned.servers[0]?.status).toBe("warn");
      expect(warned.servers[0]?.scope).toBeUndefined();
      expect(exitCode(warned)).toBe(1);
      expect(warned.summary).toEqual({
        ok: 0,
        warn: 0,
        fail: 0,
        files: 0,
        servers: 0,
        skipped: 0,
        configWarnings: 0,
      });
      expect(Object.keys(warned.summary).sort()).toEqual(SUMMARY_KEYS);

      const allowed = await runCheck({
        root: dir,
        includeUserConfig: false,
        allowMissing: true,
      });
      expect(allowed.servers[0]?.findings[0]?.code).toBe("NO_CONFIG");
      expect(allowed.servers[0]?.findings[0]?.message).toContain("--allow-missing");
      expect(allowed.servers[0]?.status).toBe("ok");
      expect(exitCode(allowed)).toBe(0);
      expect(allowed.summary).toEqual(warned.summary);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("project and user labels", () => {
  it("labels a mixed project and user report without changing summary counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-scope-root-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-scope-home-"));
    const projectFile = join(root, ".cursor", "mcp.json");
    const userFile = join(home, ".cursor", "mcp.json");
    try {
      mkdirSync(join(root, ".cursor"));
      mkdirSync(join(home, ".cursor"));
      writeFileSync(
        projectFile,
        JSON.stringify({
          mcpServers: { "repo-fs": { command: "node", args: ["--version"] } },
        }),
      );
      writeFileSync(
        userFile,
        JSON.stringify({
          mcpServers: { "home-memory": { command: "node", args: ["--version"] } },
        }),
      );
      const report = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(report.summary).toEqual({
        ok: 2,
        warn: 0,
        fail: 0,
        files: 2,
        servers: 2,
        skipped: 0,
        configWarnings: 0,
      });
      expect(Object.keys(report.summary).sort()).toEqual(SUMMARY_KEYS);

      const text = formatHuman(report);
      const row = (name: string) =>
        text.split("\n").find((line) => line.includes(`] ${name} `)) ?? "";
      expect(row("repo-fs")).toMatch(/\(stdio\)  project  /);
      expect(row("repo-fs")).toContain(projectFile);
      expect(row("home-memory")).toMatch(/\(stdio\)  user  /);
      expect(row("home-memory")).toContain(userFile);

      const json = JSON.parse(formatJson(report)) as {
        summary: typeof report.summary;
        servers: Array<{ name: string; file: string; scope?: string }>;
      };
      expect(json.summary).toEqual(report.summary);
      expect(json.servers.find((server) => server.name === "repo-fs")).toMatchObject({
        file: projectFile,
        scope: "project",
      });
      expect(json.servers.find((server) => server.name === "home-memory")).toMatchObject({
        file: userFile,
        scope: "user",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
