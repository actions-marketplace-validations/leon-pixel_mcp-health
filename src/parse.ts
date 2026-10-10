import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ConfigFile, ParsedServer, ServerTransport } from "./types.js";

const ServerEntrySchema = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    type: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const McpServersDocSchema = z.object({
  mcpServers: z.record(z.string(), ServerEntrySchema),
});

const ServersDocSchema = z.object({
  servers: z.record(z.string(), ServerEntrySchema),
});

function toTransport(
  entry: z.infer<typeof ServerEntrySchema>,
): ServerTransport {
  if (entry.url && entry.url.trim()) {
    return { kind: "http", url: entry.url.trim() };
  }
  if (entry.command && entry.command.trim()) {
    return {
      kind: "stdio",
      command: entry.command.trim(),
      args: entry.args ?? [],
    };
  }
  return { kind: "unknown" };
}

function mapServers(
  record: Record<string, z.infer<typeof ServerEntrySchema>>,
): ParsedServer[] {
  return Object.entries(record).map(([name, raw]) => ({
    name,
    transport: toTransport(raw),
    raw: raw as Record<string, unknown>,
  }));
}

export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.slice(0, 4);
  if (issues.length === 0) return error.message;
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export function parseConfigFile(path: string): ConfigFile {
  const text = readFileSync(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    const obj = json as Record<string, unknown>;

    if ("mcpServers" in obj) {
      const asMcp = McpServersDocSchema.safeParse(json);
      if (asMcp.success) {
        return {
          path,
          format: "mcpServers",
          servers: mapServers(asMcp.data.mcpServers),
        };
      }
      return {
        path,
        format: "invalid",
        servers: [],
        error: formatZodError(asMcp.error),
      };
    }

    if ("servers" in obj) {
      const asServers = ServersDocSchema.safeParse(json);
      if (asServers.success) {
        return {
          path,
          format: "servers",
          servers: mapServers(asServers.data.servers),
        };
      }
      return {
        path,
        format: "invalid",
        servers: [],
        error: formatZodError(asServers.error),
      };
    }

    return { path, format: "none", servers: [] };
  }

  return { path, format: "unknown", servers: [] };
}

/** Settings-style files may exist without an MCP section — don't hard-fail. */
export function isOptionalMcpFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.endsWith("/settings.json") ||
    normalized.endsWith("/settings.local.json") ||
    normalized.endsWith("/claude_desktop_config.json")
  );
}
