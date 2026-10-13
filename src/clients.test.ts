import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverConfigPaths, __testing } from "./discover.js";
import { parseConfigFile } from "./parse.js";
import { formatHuman, formatJson } from "./report.js";
import { runCheck } from "./run.js";
import type { HealthReport } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const fixtures = join(repo, "fixtures");

const CLAUDE_SECRETS = [
  "claude-oauth-secret-do-not-print",
  "claude-user-secret-do-not-print",
  "claude-local-secret-do-not-print",
  "claude-other-secret-do-not-print",
];

function expectSecretsHidden(report: HealthReport, secrets: string[]) {
  const dumped = `${formatHuman(report)}\n${formatJson(report)}`;
  for (const secret of secrets) {
    expect(dumped, secret).not.toContain(secret);
  }
}

function codes(report: HealthReport): string[] {
  return report.servers.flatMap((server) => server.findings.map((finding) => finding.code));
}

function names(report: HealthReport): string[] {
  return report.servers.map((server) => server.name);
}

function writeClaudeHome(home: string, root: string) {
  const template = readFileSync(join(fixtures, "claude-user", ".claude.json"), "utf8");
  const dest = join(home, ".claude.json");
  writeFileSync(dest, template.replaceAll("__ROOT__", root));
  return dest;
}

describe("Claude Code ~/.claude.json", () => {
  it("checks the user server and only the matching project entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-root-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-home-"));
    try {
      writeClaudeHome(home, root);
      const report = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(report).sort()).toEqual(["local-fs", "user-memory"]);
      expect(names(report)).not.toContain("other-db");
      expect(codes(report)).toContain("HEALTHY");
      expect(codes(report)).not.toContain("NO_CONFIG");
      expect(codes(report)).not.toContain("NO_MCP_SECTION");
      expect(codes(report)).not.toContain("SKIPPED_NO_MCP");
      expect(report.summary.fail).toBe(0);
      expectSecretsHidden(report, CLAUDE_SECRETS);
      expect(report.files.some((file) => file.endsWith(`${home}/.claude.json`) || file.endsWith(".claude.json"))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("matches a project key with a trailing slash and ignores a different root", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-slash-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-slash-home-"));
    const file = join(home, ".claude.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({
          projects: {
            [`${root}/`]: {
              mcpServers: { local: { command: "node", args: ["--version"] } },
            },
            "/definitely/not/the/scan/root": {
              mcpServers: { other: { command: "node", args: ["--version"] } },
            },
          },
        }),
      );
      const matched = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(matched)).toEqual(["local"]);

      const elsewhere = mkdtempSync(join(tmpdir(), "mcp-health-claude-other-"));
      try {
        const skipped = await runCheck({
          root: elsewhere,
          includeUserConfig: true,
          home,
          env: {},
        });
        expect(codes(skipped)).toEqual(["SKIPPED_NO_MCP"]);
        expect(codes(skipped)).not.toContain("NO_MCP_SECTION");
        expect(names(skipped)).not.toContain("local");
        expect(names(skipped)).not.toContain("other");
        expect(skipped.summary.fail).toBe(0);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("matches a Windows project key case-insensitively", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-claude-win-"));
    const file = join(dir, ".claude.json");
    try {
      writeFileSync(
        file,
        JSON.stringify({
          projects: {
            "C:\\Users\\Me\\Proj\\": {
              mcpServers: { local: { command: "node", args: ["--version"] } },
            },
            "C:\\Users\\Me\\Other": {
              mcpServers: { other: { command: "node", args: ["--version"] } },
            },
          },
        }),
      );
      const parsed = parseConfigFile(file, {
        root: "C:/Users/me/proj",
        platform: "win32",
      });
      expect(parsed.format).toBe("mcpServers");
      expect(parsed.servers.map((server) => server.name)).toEqual(["local"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the existing parser for a bad user entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-schema-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-schema-home-"));
    try {
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { bad: { command: "node", env: { PORT: 1 } } },
        }),
      );
      const report = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(codes(report)).toContain("SCHEMA_ERROR");
      expect(codes(report)).not.toContain("NO_MCP_SECTION");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads .claude.json from CLAUDE_CONFIG_DIR and from %USERPROFILE%", () => {
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-dir-"));
    const configDir = join(home, "custom-claude");
    try {
      expect(__testing.claudeCodeUserPath({ home, env: {} })).toBe(
        join(home, ".claude.json"),
      );
      expect(
        __testing.claudeCodeUserPath({
          home,
          env: { CLAUDE_CONFIG_DIR: configDir },
        }),
      ).toBe(join(configDir, ".claude.json"));
      expect(
        __testing.claudeCodeUserPath({
          platform: "win32",
          home: join(home, "not-profile"),
          env: { USERPROFILE: join(home, "profile") },
        }),
      ).toBe(join(home, "profile", ".claude.json"));
      expect(
        __testing.claudeCodeUserPath({
          platform: "win32",
          home: join(home, "not-profile"),
          env: {
            USERPROFILE: join(home, "profile"),
            CLAUDE_CONFIG_DIR: configDir,
          },
        }),
      ).toBe(join(configDir, ".claude.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("scans CLAUDE_CONFIG_DIR instead of the home file", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-override-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-override-home-"));
    const configDir = join(home, "alt");
    try {
      mkdirSync(configDir);
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { fromHome: { command: "node", args: ["--version"] } },
        }),
      );
      writeFileSync(
        join(configDir, ".claude.json"),
        JSON.stringify({
          mcpServers: { fromConfigDir: { command: "node", args: ["--version"] } },
        }),
      );
      const found = discoverConfigPaths(root, {
        includeUserConfig: true,
        home,
        env: { CLAUDE_CONFIG_DIR: configDir },
      });
      expect(found).toContain(join(configDir, ".claude.json"));
      expect(found).not.toContain(join(home, ".claude.json"));
      const report = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CLAUDE_CONFIG_DIR: configDir },
      });
      expect(names(report)).toEqual(["fromConfigDir"]);
      expect(names(report)).not.toContain("fromHome");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still reads project configs with --no-user and skips ~/.claude.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-nouser-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-nouser-home-"));
    try {
      writeClaudeHome(home, root);
      mkdirSync(join(root, ".claude"));
      writeFileSync(
        join(root, ".mcp.json"),
        JSON.stringify({
          mcpServers: { fromMcp: { command: "node", args: ["--version"] } },
        }),
      );
      writeFileSync(
        join(root, ".claude", "settings.json"),
        JSON.stringify({
          mcpServers: { fromSettings: { command: "node", args: ["--version"] } },
        }),
      );
      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped).sort()).toEqual(["fromMcp", "fromSettings"]);
      expect(skipped.files.some((file) => file.endsWith(".claude.json"))).toBe(false);
      expectSecretsHidden(skipped, CLAUDE_SECRETS);

      const cli = spawnSync(
        join(repo, "node_modules", ".bin", "tsx"),
        [join(repo, "src", "cli.ts"), "check", "--no-user", "--json", root],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            APPDATA: join(home, "AppData", "Roaming"),
            LOCALAPPDATA: join(home, "AppData", "Local"),
            CLAUDE_CONFIG_DIR: "",
            CLINE_DATA_DIR: "",
            CLINE_MCP_SETTINGS_PATH: "",
          },
        },
      );
      expect(cli.status).toBe(0);
      const output = `${cli.stdout}\n${cli.stderr}`;
      expect(output).toContain("fromMcp");
      expect(output).toContain("fromSettings");
      expect(output).not.toContain("user-memory");
      expect(output).not.toContain("local-fs");
      expect(output).not.toContain("other-db");
      for (const secret of CLAUDE_SECRETS) {
        expect(output, secret).not.toContain(secret);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Continue configs", () => {
  it("reads project block files and the config.yaml list", async () => {
    const root = join(fixtures, "continue");
    const found = discoverConfigPaths(root, { includeUserConfig: false });
    expect(found.some((file) => file.endsWith(".continue/config.yaml"))).toBe(true);
    expect(found.some((file) => file.endsWith("/browser.yaml"))).toBe(true);
    expect(found.some((file) => file.endsWith("/remote.yml"))).toBe(true);
    expect(found.some((file) => file.endsWith("/block.json"))).toBe(true);
    expect(found.some((file) => file.endsWith("/dropped.json"))).toBe(true);
    expect(found.some((file) => file.endsWith("/notes.md"))).toBe(false);

    const report = await runCheck({ root, includeUserConfig: false });
    expect(names(report).sort()).toEqual([
      "browser",
      "config-local",
      "from-block",
      "from-cursor-json",
      "no-transport",
      "remote",
    ]);
    expect(names(report)).not.toContain("from-notes");
    const byName = new Map(report.servers.map((server) => [server.name, server]));
    expect(byName.get("browser")?.transport).toBe("stdio");
    expect(byName.get("browser")?.findings.map((finding) => finding.code)).toContain(
      "UNPINNED_PACKAGE",
    );
    expect(byName.get("remote")?.transport).toBe("http");
    expect(byName.get("remote")?.status).toBe("ok");
    expect(byName.get("config-local")?.status).toBe("ok");
    expect(byName.get("from-block")?.status).toBe("ok");
    expect(byName.get("from-cursor-json")?.status).toBe("ok");
    expect(byName.get("no-transport")?.findings.map((finding) => finding.code)).toContain(
      "NO_TRANSPORT",
    );
    expect(codes(report)).not.toContain("NO_CONFIG");
    expect(codes(report)).not.toContain("PARSE_ERROR");
    expectSecretsHidden(report, [
      "continue-config-secret-do-not-print",
      "continue-server-secret-do-not-print",
      "continue-transport-secret-do-not-print",
      "notes-secret-do-not-print",
    ]);
  });

  it("skips a Continue file with no mcpServers list and ignores a missing directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-continue-skip-"));
    try {
      mkdirSync(join(root, ".continue"));
      writeFileSync(
        join(root, ".continue", "config.yaml"),
        [
          "name: Models only",
          "version: 1.0.0",
          "schema: v1",
          "models:",
          "  - name: secret-model",
          "    apiKey: continue-models-secret-do-not-print",
          "",
        ].join("\n"),
      );
      const skipped = await runCheck({ root, includeUserConfig: false });
      expect(codes(skipped)).toEqual(["SKIPPED_NO_MCP"]);
      expect(codes(skipped)).not.toContain("NO_MCP_SECTION");
      expect(skipped.summary.fail).toBe(0);
      expectSecretsHidden(skipped, ["continue-models-secret-do-not-print"]);

      const missing = mkdtempSync(join(tmpdir(), "mcp-health-continue-missing-"));
      try {
        writeFileSync(join(missing, "README.md"), "no continue directory");
        const absent = await runCheck({ root: missing, includeUserConfig: false });
        expect(codes(absent)).toEqual(["NO_CONFIG"]);
        expect(absent.summary.fail).toBe(0);

        mkdirSync(join(missing, ".continue"));
        writeFileSync(join(missing, ".continue", "mcpServers"), "not-a-directory");
        const blocked = await runCheck({ root: missing, includeUserConfig: false });
        expect(codes(blocked)).not.toContain("PARSE_ERROR");
        expect(blocked.summary.fail).toBe(0);
      } finally {
        rmSync(missing, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-string env value in a Continue list", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-continue-env-"));
    try {
      mkdirSync(join(root, ".continue"));
      writeFileSync(
        join(root, ".continue", "config.yaml"),
        [
          "mcpServers:",
          "  - name: bad",
          "    command: node",
          "    env:",
          "      PORT: 3000",
          "",
        ].join("\n"),
      );
      const report = await runCheck({ root, includeUserConfig: false });
      expect(codes(report)).toContain("SCHEMA_ERROR");
      expect(codes(report)).not.toContain("HEALTHY");
      expect(formatHuman(report)).not.toContain("3000");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads ~/.continue/config.yaml unless --no-user is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-continue-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-continue-user-home-"));
    try {
      mkdirSync(join(home, ".continue"));
      writeFileSync(
        join(home, ".continue", "config.yaml"),
        [
          "name: User",
          "version: 1.0.0",
          "schema: v1",
          "mcpServers:",
          "  - name: user-continue",
          "    command: node",
          '    args: ["--version"]',
          "    env:",
          "      TOKEN: continue-user-secret-do-not-print",
          "",
        ].join("\n"),
      );
      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(included)).toContain("user-continue");
      expectSecretsHidden(included, ["continue-user-secret-do-not-print"]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped)).not.toContain("user-continue");
      expect(skipped.files.some((file) => file.includes(".continue"))).toBe(false);
      expect(codes(skipped)).toEqual(["NO_CONFIG"]);
      expectSecretsHidden(skipped, ["continue-user-secret-do-not-print"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Junie mcp.json", () => {
  it("discovers the project file and reuses the mcpServers parser", async () => {
    const root = join(fixtures, "junie");
    const found = discoverConfigPaths(root, { includeUserConfig: false });
    expect(found.some((file) => file.endsWith(".junie/mcp/mcp.json"))).toBe(true);
    expect(__testing.PROJECT_CANDIDATES).toContain(".junie/mcp/mcp.json");

    const report = await runCheck({ root, includeUserConfig: false });
    expect(names(report).sort()).toEqual(["context7", "remote"]);
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(codes(report)).toContain("HEALTHY");
    const remote = report.servers.find((server) => server.name === "remote");
    expect(remote?.transport).toBe("http");
    expectSecretsHidden(report, ["junie-header-secret-do-not-print"]);
  });

  it("reads ~/.junie/mcp/mcp.json unless --no-user is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-junie-user-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-junie-user-home-"));
    const file = join(home, ".junie", "mcp", "mcp.json");
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          mcpServers: {
            userJunie: {
              command: "node",
              args: ["--version"],
              env: { TOKEN: "junie-user-secret-do-not-print" },
            },
          },
        }),
      );
      expect(
        __testing.userLevelPaths({ home, env: {} }).some((entry) =>
          entry.endsWith("/.junie/mcp/mcp.json"),
        ),
      ).toBe(true);

      const included = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(included)).toEqual(["userJunie"]);
      expectSecretsHidden(included, ["junie-user-secret-do-not-print"]);

      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped)).not.toContain("userJunie");
      expect(skipped.files.some((entry) => entry.includes(".junie"))).toBe(false);
      expect(codes(skipped)).toEqual(["NO_CONFIG"]);
      expectSecretsHidden(skipped, ["junie-user-secret-do-not-print"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Cline user settings", () => {
  function writeServers(file: string, name: string, secret: string) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          [name]: {
            command: "node",
            args: ["--version"],
            env: { TOKEN: secret },
          },
        },
      }),
    );
  }

  it("reads the default path, CLINE_DATA_DIR, and CLINE_MCP_SETTINGS_PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-cline-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-cline-home-"));
    const defaultFile = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    const dataDir = join(home, "cline-data");
    const dataFile = join(dataDir, "settings", "cline_mcp_settings.json");
    const decoy = join(dataDir, "data", "settings", "cline_mcp_settings.json");
    const override = join(home, "override", "cline_mcp_settings.json");
    try {
      expect(__testing.clineUserPath({ home, env: {} })).toBe(defaultFile);
      expect(__testing.clineUserPath({ home, env: { CLINE_DATA_DIR: dataDir } })).toBe(
        dataFile,
      );
      expect(
        __testing.clineUserPath({
          home,
          env: { CLINE_DATA_DIR: dataDir, CLINE_MCP_SETTINGS_PATH: override },
        }),
      ).toBe(override);

      writeServers(defaultFile, "fromDefault", "cline-default-secret-do-not-print");
      const defaults = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
      });
      expect(names(defaults)).toEqual(["fromDefault"]);
      expect(defaults.summary.fail).toBe(0);
      expectSecretsHidden(defaults, ["cline-default-secret-do-not-print"]);

      writeServers(dataFile, "fromDataDir", "cline-data-secret-do-not-print");
      writeServers(decoy, "fromDecoy", "cline-decoy-secret-do-not-print");
      const relocated = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CLINE_DATA_DIR: dataDir },
      });
      expect(names(relocated)).toEqual(["fromDataDir"]);
      expect(names(relocated)).not.toContain("fromDefault");
      expect(names(relocated)).not.toContain("fromDecoy");
      expectSecretsHidden(relocated, [
        "cline-data-secret-do-not-print",
        "cline-decoy-secret-do-not-print",
        "cline-default-secret-do-not-print",
      ]);

      writeServers(override, "fromOverride", "cline-override-secret-do-not-print");
      const explicit = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CLINE_DATA_DIR: dataDir, CLINE_MCP_SETTINGS_PATH: override },
      });
      expect(names(explicit)).toEqual(["fromOverride"]);
      expect(explicit.files).toContain(override);
      expect(explicit.files).not.toContain(defaultFile);
      expect(explicit.files).not.toContain(dataFile);
      expectSecretsHidden(explicit, ["cline-override-secret-do-not-print"]);

      const missingOverride = join(home, "does-not-exist.json");
      const missing = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: { CLINE_MCP_SETTINGS_PATH: missingOverride },
      });
      expect(codes(missing)).toEqual(["NO_CONFIG"]);
      expect(codes(missing)).not.toContain("FILE_NOT_FOUND");
      expect(missing.summary.fail).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("skips the Cline file with --no-user", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-cline-nouser-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-cline-nouser-home-"));
    const file = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    try {
      writeServers(file, "fromDefault", "cline-nouser-secret-do-not-print");
      const skipped = await runCheck({
        root,
        includeUserConfig: false,
        home,
        env: {},
      });
      expect(names(skipped)).not.toContain("fromDefault");
      expect(skipped.files).not.toContain(file);
      expect(codes(skipped)).toEqual(["NO_CONFIG"]);
      expectSecretsHidden(skipped, ["cline-nouser-secret-do-not-print"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
