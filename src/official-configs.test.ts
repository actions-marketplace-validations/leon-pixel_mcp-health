import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkConfig, isPlaceholder, unsetGeminiEnvRefs } from "./check.js";
import { parseConfigFile } from "./parse.js";
import { formatHuman, formatJson } from "./report.js";
import { runCheck } from "./run.js";
import type { HealthReport } from "./types.js";

const SECRET = "docs-secret-do-not-print";
const SECRET_NAME = "MCP_HEALTH_DOCS_SECRET_ZZ";

function codes(report: HealthReport): string[] {
  return report.servers.flatMap((server) =>
    server.findings.map((finding) => finding.code),
  );
}

function writeJson(root: string, rel: string, body: unknown): string {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
  return file;
}

describe("isPlaceholder", () => {
  it("matches doc placeholders and ignores real values", () => {
    for (const value of [
      "",
      "   ",
      "changeme",
      "YOUR_TOKEN",
      "Bearer YOUR_TOKEN",
      "REPLACE_ME",
      "your-key-here",
      "your-token-here",
      "your-api-token",
      "your-oauth-client-id",
      "your-client-secret",
      "Bearer your-token-here",
      "Bearer <token>",
      "<token>",
    ]) {
      expect(isPlaceholder(value), value).toBe(true);
    }
    for (const value of [
      "your-company",
      "application/json",
      "ghp_real_token_not_a_placeholder",
      "https://example.com",
      "${input:api-token}",
    ]) {
      expect(isPlaceholder(value), value).toBe(false);
    }
  });
});

describe("Gemini CLI httpUrl", () => {
  it("treats httpUrl as the remote URL and lets it win over command", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-httpurl-"));
    try {
      const file = writeJson(root, ".gemini/settings.json", {
        mcpServers: {
          httpServer: {
            httpUrl: "http://localhost:3000/mcp",
            timeout: 5000,
          },
          httpServerWithAuth: {
            httpUrl: "http://localhost:3000/mcp",
            headers: { Authorization: "Bearer your-api-token" },
          },
          both: {
            httpUrl: "https://example.com/mcp",
            command: "definitely-missing-bin",
          },
        },
      });
      const parsed = parseConfigFile(file);
      expect(parsed.format).toBe("mcpServers");
      expect(parsed.servers.find((server) => server.name === "httpServer")?.transport).toEqual({
        kind: "http",
        url: "http://localhost:3000/mcp",
      });
      expect(parsed.servers.find((server) => server.name === "both")?.transport).toEqual({
        kind: "http",
        url: "https://example.com/mcp",
      });

      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(report)).not.toContain("NO_TRANSPORT");
      expect(codes(report)).not.toContain("COMMAND_NOT_FOUND");
      expect(codes(report)).toContain("HEALTHY");
      expect(codes(report)).toContain("PLACEHOLDER_HEADER");
      expect(report.summary.fail).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still reads Windsurf serverUrl when httpUrl is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-serverurl-"));
    try {
      const file = writeJson(root, ".windsurf/mcp_config.json", {
        mcpServers: {
          remote: { serverUrl: "https://example.com/mcp" },
        },
      });
      expect(
        parseConfigFile(file).servers.find((server) => server.name === "remote")?.transport,
      ).toEqual({ kind: "http", url: "https://example.com/mcp" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("doc placeholder secrets", () => {
  it("warns on Cursor env, headers, and auth, and leaves a bare url healthy", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-placeholders-"));
    try {
      writeJson(root, ".cursor/mcp.json", {
        mcpServers: {
          local: {
            command: "node",
            args: ["--version"],
            env: { API_KEY: "your-key-here", COMPANY: "your-company" },
          },
          remote: {
            url: "https://mcp.example.com/sse",
            headers: { Authorization: "Bearer your-token-here" },
          },
          oauth: {
            url: "https://api.example.com/mcp",
            auth: {
              CLIENT_ID: "your-oauth-client-id",
              CLIENT_SECRET: "your-client-secret",
              scopes: ["read"],
            },
          },
          plain: { url: "https://mcp.example.com/sse" },
        },
      });
      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("local")?.findings.map((finding) => finding.code)).toEqual([
        "PLACEHOLDER_ENV",
      ]);
      expect(byName.get("local")?.findings[0]?.message).toContain("API_KEY");
      expect(byName.get("local")?.findings[0]?.message).not.toContain("your-company");
      expect(byName.get("remote")?.findings.map((finding) => finding.code)).toEqual([
        "PLACEHOLDER_HEADER",
      ]);
      expect(byName.get("oauth")?.findings.map((finding) => finding.code)).toEqual([
        "PLACEHOLDER_HEADER",
        "PLACEHOLDER_HEADER",
      ]);
      expect(byName.get("plain")?.findings.map((finding) => finding.code)).toEqual([
        "HEALTHY",
      ]);
      expect(codes(report)).not.toContain("MISSING_TRANSPORT_TYPE");
      expect(report.summary.fail).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns on Zed and Gemini header placeholders", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-header-ph-"));
    try {
      writeJson(root, ".zed/settings.json", {
        context_servers: {
          remote: {
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer <token>" },
          },
        },
      });
      writeJson(root, ".gemini/settings.json", {
        mcpServers: {
          httpServerWithAuth: {
            url: "http://localhost:3000/mcp",
            headers: {
              Authorization: "Bearer your-api-token",
              "Content-Type": "application/json",
            },
          },
        },
      });
      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(report).filter((code) => code === "PLACEHOLDER_HEADER")).toHaveLength(2);
      expect(codes(report)).not.toContain("NO_TRANSPORT");
      const dumped = `${formatHuman(report)}\n${formatJson(report)}`;
      expect(dumped).not.toContain("ghp_real_token_not_a_placeholder");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Gemini CLI $VAR env references", () => {
  afterEach(() => {
    delete process.env[SECRET_NAME];
  });

  it("warns when $NAME is unset and stays quiet when it is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-dollar-"));
    try {
      writeJson(root, ".gemini/settings.json", {
        mcpServers: {
          github: {
            command: "node",
            args: ["--version"],
            env: {
              API_KEY: "$MY_EXTERNAL_TOKEN_ZZ",
              LOG_LEVEL: "$LOG_LEVEL_ZZ",
              SET: `$${SECRET_NAME}`,
              LITERAL: "%TEMP%",
            },
          },
        },
      });
      const unset = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(unset.summary.fail).toBe(0);
      expect(codes(unset)).toContain("UNRESOLVED_VARIABLE");
      expect(codes(unset)).not.toContain("HEALTHY");
      const message = unset.servers[0]?.findings.find(
        (finding) => finding.code === "UNRESOLVED_VARIABLE",
      )?.message;
      expect(message).toContain("$MY_EXTERNAL_TOKEN_ZZ in env.API_KEY");
      expect(message).toContain("$LOG_LEVEL_ZZ in env.LOG_LEVEL");
      expect(message).toContain(`$${SECRET_NAME} in env.SET`);
      expect(message).not.toContain("%TEMP%");

      process.env[SECRET_NAME] = SECRET;
      const set = await runCheck({ root, includeUserConfig: false, env: {} });
      const setMessage =
        set.servers[0]?.findings.find((finding) => finding.code === "UNRESOLVED_VARIABLE")
          ?.message ?? "";
      expect(setMessage).not.toContain(SECRET_NAME);
      const dumped = `${formatHuman(set)}\n${formatJson(set)}`;
      expect(dumped).not.toContain(SECRET);

      const strict = await runCheck({
        root,
        includeUserConfig: false,
        env: {},
        strictVariables: true,
      });
      delete process.env[SECRET_NAME];
      expect(strict.summary.fail).toBe(1);
      expect(
        strict.servers[0]?.findings.find((finding) => finding.code === "UNRESOLVED_VARIABLE")
          ?.severity,
      ).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not warn on $NAME in a Cursor env value", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-dollar-cursor-"));
    try {
      writeJson(root, ".cursor/mcp.json", {
        mcpServers: {
          local: {
            command: "node",
            args: ["--version"],
            env: { API_KEY: "$MY_EXTERNAL_TOKEN_ZZ" },
          },
        },
      });
      const report = await runCheck({ root, includeUserConfig: false, env: {} });
      expect(codes(report)).toEqual(["HEALTHY"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns on Windows %NAME% and ignores it elsewhere", () => {
    expect(unsetGeminiEnvRefs("%TEMP%", {}, "linux")).toEqual([]);
    expect(unsetGeminiEnvRefs("%TEMP%", {}, "win32")).toEqual(["%TEMP%"]);
    expect(unsetGeminiEnvRefs("%TEMP%", { TEMP: "C:\\Temp" }, "win32")).toEqual([]);
    expect(unsetGeminiEnvRefs("${KEEP}", {}, "linux")).toEqual([]);

    const root = mkdtempSync(join(tmpdir(), "mcp-health-percent-"));
    try {
      const file = writeJson(root, ".gemini/settings.json", {
        mcpServers: {
          local: {
            command: "node",
            args: ["--version"],
            env: { TEMP_DIR: "%MCP_HEALTH_WIN_ONLY_ZZ%" },
          },
        },
      });
      const checked = checkConfig(parseConfigFile(file), {
        platform: "win32",
        cwd: root,
      });
      const findings = checked.perServer.get("local")?.findings ?? [];
      expect(findings.map((finding) => finding.code)).toContain("UNRESOLVED_VARIABLE");
      expect(findings.find((finding) => finding.code === "UNRESOLVED_VARIABLE")?.message).toContain(
        "%MCP_HEALTH_WIN_ONLY_ZZ% in env.TEMP_DIR",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Claude Code type", () => {
  it("fails a url with no type and skips type sdk", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-claude-type-"));
    const home = mkdtempSync(join(tmpdir(), "mcp-health-claude-type-home-"));
    try {
      writeJson(root, ".mcp.json", {
        mcpServers: {
          notion: { url: "https://mcp.notion.com/mcp" },
          docs: { type: "http", url: "https://example.com/mcp" },
          alias: { type: "streamable-http", url: "https://example.com/alias" },
        },
      });
      writeJson(home, ".claude.json", {
        mcpServers: {
          internal: { type: "sdk" },
          remote: { type: "http", url: "https://example.com/mcp" },
        },
      });
      const report = await runCheck({
        root,
        includeUserConfig: true,
        home,
        env: {},
        platform: "linux",
      });
      const byName = new Map(report.servers.map((server) => [server.name, server]));
      expect(byName.get("notion")?.status).toBe("fail");
      expect(byName.get("notion")?.findings.map((finding) => finding.code)).toContain(
        "MISSING_TRANSPORT_TYPE",
      );
      expect(byName.get("docs")?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(byName.get("alias")?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(byName.get("internal")?.status).toBe("ok");
      expect(byName.get("internal")?.findings.map((finding) => finding.code)).toEqual([
        "SDK_SERVER",
      ]);
      expect(codes(report)).not.toContain("NO_TRANSPORT");
      expect(byName.get("remote")?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
