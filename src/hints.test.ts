import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  commandNotFoundHint,
  missingTransportTypeHint,
  noTransportHint,
  placeholderEnvHint,
  unpinnedPackageHint,
} from "./hints.js";
import { exitCode, formatHuman, formatJson } from "./report.js";
import { runCheck } from "./run.js";
import { buildSarif, formatAnnotations } from "./sarif.js";
import type { HealthReport } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

const SECRET = "YOUR_SUPER_SECRET_VALUE";
const ARG_SECRET = "ARG_SECRET_DO_NOT_PRINT";
const QUERY_SECRET = "QUERY_SECRET_DO_NOT_PRINT";
const HEADER_SECRET = "YOUR_HEADER_SECRET";
const AUTH_SECRET = "your-client-secret";
const REAL_TOKEN = "real-token-not-a-placeholder";
const BAD_URL = "not a url";

const FINDING_KEYS = ["code", "file", "hint", "message", "server", "severity"];

function writeJson(dir: string, relative: string, value: unknown): string {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function hintFor(
  report: HealthReport,
  server: string,
  code: string,
): string {
  const finding = report.servers
    .find((row) => row.name === server)
    ?.findings.find((item) => item.code === code);
  return finding?.hint ?? "";
}

function dumped(report: HealthReport): string {
  return `${formatHuman(report)}\n${formatJson(report)}\n${formatAnnotations(report)}\n${JSON.stringify(buildSarif(report))}`;
}

describe("hint sentences", () => {
  it("drops floating tags and keeps a package spec on one line", () => {
    expect(unpinnedPackageHint("@modelcontextprotocol/server-memory")).toBe(
      'Change the package argument to "@modelcontextprotocol/server-memory@<version>".',
    );
    expect(unpinnedPackageHint("server-memory@latest")).toBe(
      'Change the package argument to "server-memory@<version>".',
    );
    expect(unpinnedPackageHint("server-memory@NEXT")).toBe(
      'Change the package argument to "server-memory@<version>".',
    );
    expect(unpinnedPackageHint("@scope/name@*")).toBe(
      'Change the package argument to "@scope/name@<version>".',
    );
    expect(unpinnedPackageHint('we"ird')).toBe(
      'Change the package argument to "we\\"ird@<version>".',
    );
    expect(commandNotFoundHint("bad\nbinary")).toBe(
      'Install "bad binary" so it is on PATH, or change "command" to a program that is already installed.',
    );
    expect(placeholderEnvHint("API KEY")).toBe(
      'Replace env "API KEY" with a real value.',
    );
    expect(placeholderEnvHint("API_KEY")).toContain('"${env:API_KEY}"');
    expect(noTransportHint()).toContain('"command"');
    expect(missingTransportTypeHint()).toContain('"type": "http"');
  });
});

describe("copy-paste fixes", () => {
  it("prints one hint per common code and does not rewrite configs", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-hints-"));
    const cursorFile = writeJson(root, ".cursor/mcp.json", {
      mcpServers: {
        "broken-binary": {
          command: "definitely-not-a-real-mcp-binary-xyz",
          args: ["--token", ARG_SECRET],
        },
        unpinned: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-memory"],
        },
        floating: {
          command: "npx",
          args: ["-y", "server-memory@latest"],
        },
        "floating-next": {
          command: "npx",
          args: ["server-memory@NEXT"],
        },
        "from-spec": {
          command: "uvx",
          args: ["--from", "mcp-server-git", "ignored-package"],
        },
        "no-transport": {
          env: {
            API_KEY: SECRET,
            "API KEY": "your-key-here",
            BLANK: "",
            OK: REAL_TOKEN,
          },
        },
        "bad-url": { url: BAD_URL },
        "bad-protocol": {
          url: `ftp://example.com/mcp?token=${QUERY_SECRET}`,
        },
        header: {
          url: "https://example.com/mcp",
          headers: { Authorization: `Bearer ${HEADER_SECRET}` },
        },
        auth: {
          url: "https://example.com/mcp",
          auth: { CLIENT_SECRET: AUTH_SECRET },
        },
        "env-file": {
          command: "node",
          args: ["--version"],
          envFile: ".env.missing-mcp-health",
        },
        healthy: { command: "node", args: ["--version"] },
      },
    });
    const claudeFile = writeJson(root, ".mcp.json", {
      mcpServers: {
        "needs-type": { url: "https://example.com/mcp" },
      },
    });
    const geminiFile = writeJson(root, ".gemini/settings.json", {
      mcpServers: { "gemini-bad": { httpUrl: "::::" } },
    });
    const windsurfFile = writeJson(root, ".windsurf/mcp_config.json", {
      mcpServers: { "windsurf-bad": { serverUrl: "not-a-server-url" } },
    });
    const before = [cursorFile, claudeFile, geminiFile, windsurfFile].map((file) =>
      readFileSync(file),
    );

    try {
      const report = await runCheck({ root, includeUserConfig: false });
      expect([cursorFile, claudeFile, geminiFile, windsurfFile].map((file) =>
        readFileSync(file),
      )).toEqual(before);
      expect(exitCode(report)).toBe(2);

      const expectHint = (server: string, code: string, hint: string) => {
        expect(hintFor(report, server, code)).toBe(hint);
      };

      const commandHint = commandNotFoundHint(
        "definitely-not-a-real-mcp-binary-xyz",
      );
      expectHint("broken-binary", "COMMAND_NOT_FOUND", commandHint);
      expectHint(
        "unpinned",
        "UNPINNED_PACKAGE",
        'Change the package argument to "@modelcontextprotocol/server-memory@<version>".',
      );
      expectHint(
        "floating",
        "UNPINNED_PACKAGE",
        'Change the package argument to "server-memory@<version>".',
      );
      expectHint(
        "floating-next",
        "UNPINNED_PACKAGE",
        'Change the package argument to "server-memory@<version>".',
      );
      expectHint(
        "from-spec",
        "UNPINNED_PACKAGE",
        'Change the package argument to "mcp-server-git@<version>".',
      );
      expect(hintFor(report, "from-spec", "UNPINNED_PACKAGE")).not.toContain(
        "ignored-package",
      );
      expectHint("bad-url", "BAD_URL", badUrl("url"));
      expectHint(
        "bad-protocol",
        "BAD_URL_PROTOCOL",
        'Replace the ftp: value of "url" with a supported URL such as "https://example.com/mcp".',
      );
      expectHint("gemini-bad", "BAD_URL", badUrl("httpUrl"));
      expectHint("windsurf-bad", "BAD_URL", badUrl("serverUrl"));
      expectHint(
        "no-transport",
        "PLACEHOLDER_ENV",
        'Replace env "API_KEY" with a real value, or paste "API_KEY": "${env:API_KEY}".',
      );
      const envHints = report.servers
        .find((server) => server.name === "no-transport")
        ?.findings.filter((finding) => finding.code === "PLACEHOLDER_ENV")
        .map((finding) => finding.hint);
      expect(envHints).toEqual([
        'Replace env "API_KEY" with a real value, or paste "API_KEY": "${env:API_KEY}".',
        'Replace env "API KEY" with a real value.',
        'Replace env "BLANK" with a real value, or paste "BLANK": "${env:BLANK}".',
      ]);
      expectHint("no-transport", "NO_TRANSPORT", noTransportHint());
      expectHint(
        "header",
        "PLACEHOLDER_HEADER",
        'Replace headers "Authorization" with a real value, or paste "Authorization": "${env:Authorization}".',
      );
      expectHint(
        "auth",
        "PLACEHOLDER_HEADER",
        'Replace auth "CLIENT_SECRET" with a real value, or paste "CLIENT_SECRET": "${env:CLIENT_SECRET}".',
      );
      expectHint(
        "env-file",
        "ENV_FILE_MISSING",
        'Create ".env.missing-mcp-health", or set "envFile" to a file that exists.',
      );
      expectHint("needs-type", "MISSING_TRANSPORT_TYPE", missingTransportTypeHint());

      const broken = report.servers.find((server) => server.name === "broken-binary");
      const commandFinding = broken?.findings.find(
        (finding) => finding.code === "COMMAND_NOT_FOUND",
      );
      expect(commandFinding?.message).toBe(
        "Command not found on PATH: definitely-not-a-real-mcp-binary-xyz",
      );
      expect(Object.keys(commandFinding ?? {}).sort()).toEqual(FINDING_KEYS);
      expect(broken).toMatchObject({
        transport: "stdio",
        status: "fail",
        scope: "project",
      });

      const healthy = report.servers.find((server) => server.name === "healthy");
      expect(healthy?.findings.map((finding) => finding.code)).toEqual(["HEALTHY"]);
      expect(healthy?.findings[0]).not.toHaveProperty("hint");
      expect(Object.keys(healthy?.findings[0] ?? {}).sort()).not.toContain("hint");

      const text = formatHuman(report);
      expect(text).toContain(
        `    - FAIL COMMAND_NOT_FOUND: Command not found on PATH: definitely-not-a-real-mcp-binary-xyz\n      ${commandHint}`,
      );
      expect(text).toContain(
        `    - WARN UNPINNED_PACKAGE: Package "@modelcontextprotocol/server-memory" is not version-pinned (recommend name@version)\n      Change the package argument to "@modelcontextprotocol/server-memory@<version>".`,
      );
      expect(text).toContain(
        `    - FAIL BAD_URL: Invalid URL: ${BAD_URL}\n      ${badUrl("url")}`,
      );
      expect(text).toContain(
        `    - FAIL NO_TRANSPORT: Server has neither command nor url\n      ${noTransportHint()}`,
      );
      expect(text).toContain(
        `    - FAIL MISSING_TRANSPORT_TYPE: Claude Code skips a url entry with no type. Add "type": "http", "sse", or "ws".\n      ${missingTransportTypeHint()}`,
      );

      const json = JSON.parse(formatJson(report)) as HealthReport;
      expect(
        json.servers
          .find((server) => server.name === "unpinned")
          ?.findings.find((finding) => finding.code === "UNPINNED_PACKAGE")?.hint,
      ).toContain("@modelcontextprotocol/server-memory@<version>");
      expect(
        json.servers.find((server) => server.name === "healthy")?.findings[0],
      ).not.toHaveProperty("hint");

      const sarif = buildSarif(report) as {
        runs: Array<{ results: Array<{ ruleId: string; message: { text: string } }> }>;
      };
      const sarifText = (rule: string, server: string) =>
        sarif.runs[0]?.results.find(
          (result) =>
            result.ruleId === rule && result.message.text.startsWith(`${server}:`),
        )?.message.text ?? "";
      expect(sarifText("COMMAND_NOT_FOUND", "broken-binary")).toContain(commandHint);
      expect(sarifText("UNPINNED_PACKAGE", "unpinned")).toContain(
        '"@modelcontextprotocol/server-memory@<version>"',
      );
      expect(sarifText("BAD_URL", "bad-url")).toContain(badUrl("url"));
      expect(sarifText("BAD_URL_PROTOCOL", "bad-protocol")).toContain("ftp:");
      expect(sarifText("PLACEHOLDER_ENV", "no-transport")).toContain("API_KEY");
      expect(sarifText("PLACEHOLDER_HEADER", "header")).toContain("Authorization");
      expect(sarifText("ENV_FILE_MISSING", "env-file")).toContain(
        ".env.missing-mcp-health",
      );
      expect(sarifText("NO_TRANSPORT", "no-transport")).toContain(noTransportHint());
      expect(sarifText("MISSING_TRANSPORT_TYPE", "needs-type")).toContain(
        '"type": "http"',
      );
      expect(sarif.runs[0]?.results.some((result) => result.ruleId === "HEALTHY")).toBe(
        false,
      );

      const notes = formatAnnotations(report);
      expect(notes).toContain(commandHint);
      expect(notes).toContain("::error ");
      expect(notes).toContain("::warning ");
      expect(notes).toContain('"type": "http"');

      const rendered = dumped(report);
      for (const secret of [SECRET, ARG_SECRET, QUERY_SECRET, HEADER_SECRET, AUTH_SECRET, REAL_TOKEN]) {
        expect(rendered, secret).not.toContain(secret);
      }
      expect(hintFor(report, "bad-url", "BAD_URL")).not.toContain(BAD_URL);
      expect(hintFor(report, "bad-protocol", "BAD_URL_PROTOCOL")).not.toContain(
        QUERY_SECRET,
      );
      expect(hintFor(report, "floating", "UNPINNED_PACKAGE")).not.toContain("@latest");
      expect(hintFor(report, "floating-next", "UNPINNED_PACKAGE")).not.toContain("NEXT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps exit 1 for a warning and exit 0 when every server is healthy", async () => {
    const warned = mkdtempSync(join(tmpdir(), "mcp-health-hint-warn-"));
    const clean = mkdtempSync(join(tmpdir(), "mcp-health-hint-ok-"));
    try {
      writeJson(warned, "mcp.json", {
        mcpServers: {
          local: {
            command: "node",
            args: ["--version"],
            env: { API_KEY: "your-key-here" },
          },
        },
      });
      writeJson(clean, "mcp.json", {
        mcpServers: { local: { command: "node", args: ["--version"] } },
      });
      const warnReport = await runCheck({ root: warned, includeUserConfig: false });
      expect(exitCode(warnReport)).toBe(1);
      expect(warnReport.summary).toMatchObject({ warn: 1, fail: 0 });
      expect(hintFor(warnReport, "local", "PLACEHOLDER_ENV")).toContain("API_KEY");
      expect(formatHuman(warnReport)).not.toContain("your-key-here");

      const okReport = await runCheck({ root: clean, includeUserConfig: false });
      expect(exitCode(okReport)).toBe(0);
      expect(
        formatHuman(okReport)
          .split("\n")
          .some((line) => line.startsWith("      ")),
      ).toBe(false);
    } finally {
      rmSync(warned, { recursive: true, force: true });
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it("rejects --fix and leaves the config bytes unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-health-no-fix-"));
    const file = writeJson(root, "mcp.json", {
      mcpServers: {
        broken: { command: "definitely-not-a-real-mcp-binary-xyz" },
      },
    });
    const before = readFileSync(file);
    const tsx = join(repo, "node_modules", ".bin", "tsx");
    try {
      const help = spawnSync(tsx, [join(repo, "src", "cli.ts"), "check", "--help"], {
        encoding: "utf8",
      });
      expect(help.status).toBe(0);
      expect(help.stdout).not.toContain("--fix");

      const rejected = spawnSync(
        tsx,
        [join(repo, "src", "cli.ts"), "check", "--no-user", "--fix", root],
        { encoding: "utf8" },
      );
      expect(rejected.status).toBe(1);
      expect(`${rejected.stdout}\n${rejected.stderr}`.toLowerCase()).toContain(
        "unknown option",
      );
      expect(readFileSync(file)).toEqual(before);

      const ran = spawnSync(
        tsx,
        [join(repo, "src", "cli.ts"), "check", "--no-user", root],
        { encoding: "utf8" },
      );
      expect(ran.status).toBe(2);
      expect(ran.stdout).toContain(
        'Install "definitely-not-a-real-mcp-binary-xyz" so it is on PATH, or change "command" to a program that is already installed.',
      );
      expect(readFileSync(file)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function badUrl(field: string): string {
  return `Set "${field}" to an absolute URL such as "https://example.com/mcp".`;
}
