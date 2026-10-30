import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type StarterClient = "cursor" | "vscode" | "antigravity";

/** Pinned package. An unpinned name would be UNPINNED_PACKAGE. */
const PINNED_PACKAGE = "@modelcontextprotocol/server-filesystem@0.6.2";

export type StarterConfig = {
  client: StarterClient;
  /** Project-relative path this client loads. */
  path: string;
  /** File bytes, including the trailing newline. No secrets and no placeholders. */
  body: string;
};

const CLIENT_NAMES = "cursor, vscode, or antigravity";

export function parseStarterClient(value: string): StarterClient | undefined {
  const key = value.trim().toLowerCase();
  if (key === "cursor") return "cursor";
  if (key === "vscode" || key === "vs-code") return "vscode";
  if (key === "antigravity") return "antigravity";
  return undefined;
}

export function resolveStarterClient(
  argument: string | undefined,
  flag: string | undefined,
): { ok: true; client: StarterClient } | { ok: false; message: string } {
  const named = (value: string | undefined) => {
    if (value === undefined || value.trim() === "") return { present: false as const };
    const client = parseStarterClient(value);
    if (!client) {
      return {
        present: true as const,
        ok: false as const,
        message: `Unknown client "${value}". Expected ${CLIENT_NAMES}.`,
      };
    }
    return { present: true as const, ok: true as const, client };
  };

  const fromArg = named(argument);
  if (fromArg.present && !fromArg.ok) return { ok: false, message: fromArg.message };
  const fromFlag = named(flag);
  if (fromFlag.present && !fromFlag.ok) return { ok: false, message: fromFlag.message };
  if (
    fromArg.present &&
    fromArg.ok &&
    fromFlag.present &&
    fromFlag.ok &&
    fromArg.client !== fromFlag.client
  ) {
    return {
      ok: false,
      message: `Client "${argument}" does not match --client ${flag}. Expected ${CLIENT_NAMES}.`,
    };
  }
  const client =
    (fromFlag.present && fromFlag.ok ? fromFlag.client : undefined) ??
    (fromArg.present && fromArg.ok ? fromArg.client : undefined) ??
    "cursor";
  return { ok: true, client };
}

export function starterConfig(client: StarterClient): StarterConfig {
  const stdio = {
    command: "npx",
    args: ["-y", PINNED_PACKAGE, "."],
  };
  if (client === "cursor") {
    return {
      client,
      path: ".cursor/mcp.json",
      body: json({
        mcpServers: {
          filesystem: stdio,
          remote: { url: "https://example.com/mcp" },
        },
      }),
    };
  }
  if (client === "vscode") {
    return {
      client,
      path: ".vscode/mcp.json",
      body: json({
        servers: {
          filesystem: stdio,
          remote: { url: "https://example.com/mcp" },
        },
      }),
    };
  }
  return {
    client,
    path: ".agents/mcp_config.json",
    body: json({
      mcpServers: {
        filesystem: stdio,
        remote: { serverUrl: "https://example.com/mcp" },
      },
    }),
  };
}

/** Path line, then the config. Print-only output. */
export function formatStarter(config: StarterConfig): string {
  return `${config.path}\n${config.body}`;
}

/**
 * Create `config.path` under `root` when it is missing.
 * An existing file or directory is not opened for write.
 */
export function writeStarter(
  root: string,
  config: StarterConfig,
): { ok: true } | { ok: false; message: string } {
  const absolute = join(root, config.path);
  if (existsSync(absolute)) {
    return { ok: false, message: `Refusing to overwrite ${config.path}` };
  }
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, config.body, { flag: "wx" });
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
    if (code === "EEXIST") {
      return { ok: false, message: `Refusing to overwrite ${config.path}` };
    }
    const detail = err instanceof Error ? err.message : "unknown error";
    return { ok: false, message: `Could not write ${config.path}: ${detail}` };
  }
  return { ok: true };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
