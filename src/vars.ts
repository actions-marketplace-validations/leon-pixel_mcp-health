import { homedir } from "node:os";
import { basename, sep } from "node:path";
import type { ParsedServer } from "./types.js";

const VARIABLE = /\$\{([^{}]+)\}/g;

export type ExpandContext = {
  /** Project root passed to the scan. This is `${workspaceFolder}`. */
  root: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export function lookupEnv(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined) {
    return env[name];
  }
  if (platform !== "win32") return undefined;
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === want && value !== undefined) return value;
  }
  return undefined;
}

/**
 * Expand the VS Code / Cursor variables a config scan can know about.
 * Unknown tokens, including `${input:…}`, are left in place so the
 * checker can report them instead of treating the server as healthy.
 */
export function expandString(input: string, ctx: ExpandContext): string {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  return input.replace(VARIABLE, (full, raw: string) => {
    const key = raw.trim();
    if (key === "workspaceFolder" || key === "cwd") return ctx.root;
    if (key === "workspaceFolderBasename") return basename(ctx.root);
    if (key === "userHome") return homedir();
    if (key === "pathSeparator" || key === "/") return sep;
    if (key.startsWith("env:")) {
      const name = key.slice("env:".length).trim();
      if (!name) return full;
      const value = lookupEnv(name, env, platform);
      if (value === undefined) return full;
      return value;
    }
    return full;
  });
}

function expandStringRecord(
  record: unknown,
  ctx: ExpandContext,
): Record<string, unknown> | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = typeof value === "string" ? expandString(value, ctx) : value;
  }
  return out;
}

export function expandServerVariables(
  server: ParsedServer,
  ctx: ExpandContext,
): ParsedServer {
  const raw: Record<string, unknown> = { ...server.raw };
  const env = expandStringRecord(raw.env, ctx);
  if (env) raw.env = env;
  const headers = expandStringRecord(raw.headers, ctx);
  if (headers) raw.headers = headers;

  if (server.transport.kind === "stdio") {
    return {
      ...server,
      raw,
      transport: {
        kind: "stdio",
        command: expandString(server.transport.command, ctx),
        args: server.transport.args.map((arg) => expandString(arg, ctx)),
      },
    };
  }

  if (server.transport.kind === "http") {
    return {
      ...server,
      raw,
      transport: {
        kind: "http",
        url: expandString(server.transport.url, ctx),
      },
    };
  }

  return { ...server, raw };
}
