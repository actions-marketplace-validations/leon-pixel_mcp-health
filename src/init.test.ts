import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatStarter,
  resolveStarterClient,
  starterConfig,
  writeStarter,
} from "./init.js";
import { runCheck } from "./run.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(repo, "node_modules", ".bin", "tsx");
const cli = join(repo, "src", "cli.ts");

function runCli(args: string[], cwd: string) {
  return spawnSync(tsx, [cli, ...args], { encoding: "utf8", cwd });
}

describe("starter configs", () => {
  it("prints Cursor, VS Code, and Antigravity examples without placeholders", () => {
    const cursor = starterConfig("cursor");
    const vscode = starterConfig("vscode");
    const antigravity = starterConfig("antigravity");

    expect(cursor.path).toBe(".cursor/mcp.json");
    expect(vscode.path).toBe(".vscode/mcp.json");
    expect(antigravity.path).toBe(".agents/mcp_config.json");

    const cursorJson = JSON.parse(cursor.body) as {
      mcpServers: Record<string, { command?: string; args?: string[]; url?: string }>;
    };
    expect(cursorJson.mcpServers.filesystem?.args).toContain(
      "@modelcontextprotocol/server-filesystem@0.6.2",
    );
    expect(cursorJson.mcpServers.filesystem?.command).toBe("npx");
    expect(cursorJson.mcpServers.remote?.url).toBe("https://example.com/mcp");

    const vscodeJson = JSON.parse(vscode.body) as {
      servers: Record<string, { url?: string; args?: string[] }>;
      mcpServers?: unknown;
    };
    expect(vscodeJson.mcpServers).toBeUndefined();
    expect(vscodeJson.servers.filesystem?.args).toContain(
      "@modelcontextprotocol/server-filesystem@0.6.2",
    );
    expect(vscodeJson.servers.remote?.url).toBe("https://example.com/mcp");

    const antigravityJson = JSON.parse(antigravity.body) as {
      mcpServers: Record<string, { serverUrl?: string; url?: string }>;
    };
    expect(antigravityJson.mcpServers.remote?.serverUrl).toBe("https://example.com/mcp");
    expect(antigravityJson.mcpServers.remote?.url).toBeUndefined();

    for (const starter of [cursor, vscode, antigravity]) {
      expect(starter.body.endsWith("\n")).toBe(true);
      expect(starter.body).not.toContain("YOUR_");
      expect(starter.body).not.toContain("your-key-here");
      expect(starter.body).not.toMatch(/secret|token|password|api[_-]?key/i);
      expect(formatStarter(starter).startsWith(`${starter.path}\n`)).toBe(true);
    }
  });

  it("selects a client from an argument or --client and rejects a mismatch", () => {
    expect(resolveStarterClient(undefined, undefined)).toEqual({ ok: true, client: "cursor" });
    expect(resolveStarterClient("vscode", undefined)).toEqual({ ok: true, client: "vscode" });
    expect(resolveStarterClient("vs-code", undefined)).toEqual({ ok: true, client: "vscode" });
    expect(resolveStarterClient(undefined, "Antigravity")).toEqual({
      ok: true,
      client: "antigravity",
    });
    expect(resolveStarterClient("vscode", "vscode").ok).toBe(true);
    expect(resolveStarterClient("nope", undefined).ok).toBe(false);
    expect(resolveStarterClient("vscode", "antigravity").ok).toBe(false);
  });

  it("writes a missing file and refuses to overwrite an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-init-unit-"));
    try {
      const starter = starterConfig("cursor");
      const target = join(dir, starter.path);
      expect(writeStarter(dir, starter)).toEqual({ ok: true });
      expect(readFileSync(target, "utf8")).toBe(starter.body);

      writeFileSync(target, "ORIGINAL-BYTES\n");
      const refused = writeStarter(dir, starter);
      expect(refused.ok).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("ORIGINAL-BYTES\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mcp-health init", () => {
  it("prints a config and does not create or modify a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-init-print-"));
    const keep = join(dir, "notes.txt");
    try {
      writeFileSync(keep, "keep\n");
      const printed = runCli(["init"], dir);
      expect(printed.status).toBe(0);
      expect(printed.stdout).toBe(formatStarter(starterConfig("cursor")));
      expect(printed.stdout).not.toContain("scanned");
      expect(readFileSync(keep, "utf8")).toBe("keep\n");
      expect(existsSync(join(dir, ".cursor", "mcp.json"))).toBe(false);

      const existing = join(dir, ".cursor", "mcp.json");
      mkdirSync(join(dir, ".cursor"));
      writeFileSync(existing, "ORIGINAL-BYTES\n");
      const again = runCli(["init"], dir);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain(".cursor/mcp.json");
      expect(readFileSync(existing, "utf8")).toBe("ORIGINAL-BYTES\n");
      expect(readFileSync(keep, "utf8")).toBe("keep\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a missing file and prints the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-init-write-"));
    try {
      const result = runCli(["init", "--write"], dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(".cursor/mcp.json\n");
      expect(result.stderr).toBe("");
      expect(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8")).toBe(
        starterConfig("cursor").body,
      );
      expect(readdirSync(dir).sort()).toEqual([".cursor"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-init-overwrite-"));
    const target = join(dir, ".cursor", "mcp.json");
    const keep = join(dir, "README.md");
    try {
      mkdirSync(join(dir, ".cursor"));
      writeFileSync(target, "ORIGINAL-BYTES\n");
      writeFileSync(keep, "keep\n");
      const result = runCli(["init", "cursor", "--write"], dir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(".cursor/mcp.json");
      expect(result.stdout).not.toContain("mcpServers");
      expect(readFileSync(target, "utf8")).toBe("ORIGINAL-BYTES\n");
      expect(readFileSync(keep, "utf8")).toBe("keep\n");
      expect(readdirSync(join(dir, ".cursor"))).toEqual(["mcp.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selects VS Code and Antigravity with an argument or --client", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-init-clients-"));
    try {
      const vscode = runCli(["init", "vscode"], dir);
      expect(vscode.status).toBe(0);
      expect(vscode.stdout.startsWith(".vscode/mcp.json\n")).toBe(true);
      expect(vscode.stdout).toContain('"servers"');
      expect(existsSync(join(dir, ".vscode"))).toBe(false);

      const alias = runCli(["init", "--client", "vs-code"], dir);
      expect(alias.status).toBe(0);
      expect(alias.stdout.startsWith(".vscode/mcp.json\n")).toBe(true);

      const antigravity = runCli(["init", "--client", "antigravity"], dir);
      expect(antigravity.status).toBe(0);
      expect(antigravity.stdout.startsWith(".agents/mcp_config.json\n")).toBe(true);
      expect(antigravity.stdout).toContain('"serverUrl"');
      expect(existsSync(join(dir, ".agents"))).toBe(false);

      const wroteVscode = runCli(["init", "vscode", "--write"], dir);
      expect(wroteVscode.status).toBe(0);
      expect(wroteVscode.stdout).toBe(".vscode/mcp.json\n");
      expect(readFileSync(join(dir, ".vscode", "mcp.json"), "utf8")).toBe(
        starterConfig("vscode").body,
      );
      expect(existsSync(join(dir, ".cursor"))).toBe(false);

      const wroteAnti = runCli(["init", "antigravity", "--write"], dir);
      expect(wroteAnti.status).toBe(0);
      expect(wroteAnti.stdout).toBe(".agents/mcp_config.json\n");
      expect(readFileSync(join(dir, ".agents", "mcp_config.json"), "utf8")).toBe(
        starterConfig("antigravity").body,
      );

      const report = await runCheck({ root: dir, includeUserConfig: false, env: {} });
      const codes = report.servers.flatMap((server) =>
        server.findings.map((finding) => finding.code),
      );
      expect(codes).not.toContain("NO_CONFIG");
      expect(codes).not.toContain("PLACEHOLDER_ENV");
      expect(codes).not.toContain("PLACEHOLDER_ARG");
      expect(codes).not.toContain("PLACEHOLDER_HEADER");
      expect(codes).not.toContain("UNPINNED_PACKAGE");
      expect(JSON.stringify(report)).not.toMatch(/YOUR_|your-key-here/);
      expect(report.summary.fail).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not write when the client is unknown or the selectors disagree", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-init-bad-"));
    try {
      const unknown = runCli(["init", "--write", "--client", "nope"], dir);
      expect(unknown.status).not.toBe(0);
      expect(unknown.stderr).toContain("Unknown client");
      expect(readdirSync(dir)).toEqual([]);

      const mismatch = runCli(["init", "vscode", "--client", "antigravity", "--write"], dir);
      expect(mismatch.status).not.toBe(0);
      expect(mismatch.stderr).toContain("does not match");
      expect(readdirSync(dir)).toEqual([]);

      writeFileSync(join(dir, ".cursor"), "not-a-directory\n");
      const blocked = runCli(["init", "--write"], dir);
      expect(blocked.status).not.toBe(0);
      expect(readFileSync(join(dir, ".cursor"), "utf8")).toBe("not-a-directory\n");
      expect(existsSync(join(dir, ".cursor", "mcp.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("documents init and --write in help and the README", () => {
    const help = runCli(["init", "--help"], repo);
    expect(help.status).toBe(0);
    const text = help.stdout.replace(/\s+/g, " ");
    expect(text).toContain("--write");
    expect(text).toContain("cursor");
    expect(text).toContain("vscode");
    expect(text).toContain("antigravity");
    expect(text).toContain(".cursor/mcp.json");
    expect(text).toContain(".vscode/mcp.json");
    expect(text).toContain(".agents/mcp_config.json");
    expect(text).toContain("--client");

    const root = runCli(["--help"], repo);
    expect(root.status).toBe(0);
    expect(root.stdout).toContain("init");
    expect(root.stdout).toContain("check");

    const readme = readFileSync(join(repo, "README.md"), "utf8");
    expect(readme).toContain("mcp-health init");
    expect(readme).toContain("mcp-health init vscode");
    expect(readme).toContain("mcp-health init antigravity");
    expect(readme).toContain("mcp-health init --write");
    expect(readme).toContain("mcp-health init vscode --write");
    expect(readme).toContain("exit 1 because of a config-level warning (NO_CONFIG)");
  });

  it("does not import the scanner or a network client", () => {
    const source = readFileSync(join(repo, "src", "init.ts"), "utf8");
    expect(source).not.toMatch(/from "\.\/(run|check|npm|probe|discover|sarif)\.js"/);
    expect(source).not.toContain("fetch(");
  });
});

describe("zero-config CLI", () => {
  it("explains NO_CONFIG on the summary line and does not write a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-init-noconfig-"));
    try {
      const warned = runCli(["check", "--no-user", dir], dir);
      expect(warned.status).toBe(1);
      expect(warned.stdout.split("\n")[1]).toBe(
        "files: 0  servers: 0  ok: 0  warn: 0  fail: 0  skipped: 0  exit 1 because of a config-level warning (NO_CONFIG)",
      );
      expect(warned.stdout).toContain("mcp-health init");
      expect(warned.stdout).toContain(".cursor/mcp.json");
      expect(warned.stdout).toContain(".vscode/mcp.json");
      expect(warned.stdout).toContain("--allow-missing");
      expect(readdirSync(dir)).toEqual([]);

      const allowed = runCli(["check", "--no-user", "--allow-missing", dir], dir);
      expect(allowed.status).toBe(0);
      const header = allowed.stdout.split("\n")[1] ?? "";
      expect(header).toBe("files: 0  servers: 0  ok: 0  warn: 0  fail: 0  skipped: 0");
      expect(header).not.toContain("exit 1");
      expect(allowed.stdout).toContain("NO_CONFIG");
      expect(readdirSync(dir)).toEqual([]);

      const json = runCli(["check", "--no-user", "--json", dir], dir);
      expect(json.status).toBe(1);
      const parsed = JSON.parse(json.stdout) as {
        servers: Array<{ findings: Array<{ code: string }> }>;
        summary: { warn: number; configWarnings: number; servers: number };
      };
      expect(parsed.servers[0]?.findings[0]?.code).toBe("NO_CONFIG");
      expect(parsed.summary).toMatchObject({ warn: 0, configWarnings: 0, servers: 0 });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
