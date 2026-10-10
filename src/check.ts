import type { ConfigFile, Finding, ParsedServer, Severity } from "./types.js";
import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const UNRESOLVED_VAR = /\$\{[^{}]+\}/g;

function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function pathExtensions(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32") return [""];
  const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const exts = raw
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
  return ["", ...exts];
}

function hasPathExtension(command: string, extensions: string[]): boolean {
  const lower = command.toLowerCase();
  return extensions.some(
    (ext) => ext.length > 0 && lower.endsWith(ext.toLowerCase()),
  );
}

function isRunnable(file: string, platform: NodeJS.Platform): boolean {
  if (!existsSync(file)) return false;
  if (platform === "win32") return true;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `.cmd` and `.bat` files do not start via spawn() unless `shell` is set.
 * `.exe` does not need a shell.
 */
export function commandNeedsShell(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(executable);
}

/**
 * Resolve a command the way the host shell would.
 * On Windows, `npx` is `npx.cmd` / `npx.exe` and is found via PATHEXT.
 * Returns an absolute path when the command is on PATH.
 */
export function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const extensions = pathExtensions(env, platform);
  const names =
    platform === "win32" && !hasPathExtension(command, extensions)
      ? extensions.map((ext) => `${command}${ext}`)
      : [command];

  const direct =
    isAbsolute(command) || command.includes("/") || command.includes("\\");
  if (direct) {
    for (const name of names) {
      if (isRunnable(name, platform)) return name;
    }
    return undefined;
  }

  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(pathDelimiter(platform))) {
    if (!dir) continue;
    for (const name of names) {
      const full = join(dir, name);
      if (isRunnable(full, platform)) return full;
    }
  }
  return undefined;
}

function commandOnPath(command: string): boolean {
  return resolveCommandOnPath(command) !== undefined;
}

function unresolvedTokens(value: string): string[] {
  return value.match(UNRESOLVED_VAR) ?? [];
}

function unresolvedVariableFinding(
  server: ParsedServer,
  file: string,
): Finding | undefined {
  const hits: string[] = [];
  const add = (where: string, value: string) => {
    for (const token of unresolvedTokens(value)) {
      hits.push(`${token} in ${where}`);
    }
  };

  if (server.transport.kind === "stdio") {
    add("command", server.transport.command);
    server.transport.args.forEach((arg, index) => add(`args[${index}]`, arg));
  } else if (server.transport.kind === "http") {
    add("url", server.transport.url);
  }

  const env = server.raw.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") add(`env.${key}`, value);
    }
  }

  const headers = server.raw.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") add(`headers.${key}`, value);
    }
  }

  if (hits.length === 0) return undefined;
  return {
    severity: "fail",
    code: "UNRESOLVED_VARIABLE",
    message: `Unresolved config variable ${hits.join("; ")}. workspaceFolder, userHome, pathSeparator, and env are expanded; input and other variables are not`,
    server: server.name,
    file,
  };
}

/** True when package ref includes an explicit version after the name. */
export function isVersionPinned(pkg: string): boolean {
  if (pkg.startsWith("@")) {
    // @scope/name@version
    return /^@[^/]+\/[^@]+@.+$/.test(pkg);
  }
  // name@version
  return /^[^@]+@.+$/.test(pkg);
}

export function extractNpxPackage(command: string, args: string[]): string | undefined {
  const cleaned = args.filter((a) => a !== "-y" && a !== "--yes" && a !== "--");
  if (command === "npx" || command.endsWith("/npx") || command.endsWith("\\npx")) {
    const pkg = cleaned.find((a) => !a.startsWith("-"));
    return pkg;
  }
  const base = command.split(/[/\\]/).pop() ?? command;
  if (base === "npx" || base === "npx.cmd" || base === "npx.exe") {
    const pkg = cleaned.find((a) => !a.startsWith("-"));
    return pkg;
  }
  if (command === "npm" || base === "npm" || base === "npm.cmd" || base === "npm.exe") {
    // npm exec [-y] pkg
    const execIdx = cleaned.indexOf("exec");
    if (execIdx === -1) return undefined;
    const rest = cleaned.slice(execIdx + 1).filter((a) => !a.startsWith("-"));
    return rest[0];
  }
  return undefined;
}

function worst(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function checkConfig(file: ConfigFile): {
  findings: Finding[];
  perServer: Map<string, { status: Severity; findings: Finding[] }>;
} {
  const findings: Finding[] = [];
  const perServer = new Map<
    string,
    { status: Severity; findings: Finding[] }
  >();

  if (file.format === "invalid") {
    findings.push({
      severity: "fail",
      code: "SCHEMA_ERROR",
      message: file.error ?? "MCP config failed schema validation",
      file: file.path,
    });
    return { findings, perServer };
  }

  if (file.format === "unknown") {
    findings.push({
      severity: "fail",
      code: "UNKNOWN_FORMAT",
      message:
        "Config is not a JSON object with mcpServers/servers (or was invalid shape)",
      file: file.path,
    });
    return { findings, perServer };
  }

  if (file.format === "none") {
    findings.push({
      severity: "warn",
      code: "NO_MCP_SECTION",
      message: "JSON has no mcpServers or servers key",
      file: file.path,
    });
    return { findings, perServer };
  }

  if (file.servers.length === 0) {
    findings.push({
      severity: "warn",
      code: "EMPTY_SERVERS",
      message: "Config contains an empty server map",
      file: file.path,
    });
  }

  for (const server of file.servers) {
    const local: Finding[] = [];
    let status: Severity = "ok";

    if (!server.name.trim()) {
      local.push({
        severity: "fail",
        code: "EMPTY_NAME",
        message: "Server name is empty",
        server: server.name,
        file: file.path,
      });
    }

    const unresolved = unresolvedVariableFinding(server, file.path);
    if (unresolved) local.push(unresolved);

    if (server.transport.kind === "unknown") {
      local.push({
        severity: "fail",
        code: "NO_TRANSPORT",
        message: "Server has neither command nor url",
        server: server.name,
        file: file.path,
      });
    }

    if (server.transport.kind === "http") {
      try {
        const u = new URL(server.transport.url);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          local.push({
            severity: "fail",
            code: "BAD_URL_PROTOCOL",
            message: `URL must be http(s), got ${u.protocol}`,
            server: server.name,
            file: file.path,
          });
        }
      } catch {
        local.push({
          severity: "fail",
          code: "BAD_URL",
          message: `Invalid URL: ${server.transport.url}`,
          server: server.name,
          file: file.path,
        });
      }
    }

    if (server.transport.kind === "stdio") {
      const { command, args } = server.transport;
      const commandUnresolved = unresolvedTokens(command).length > 0;

      if (!commandUnresolved && !commandOnPath(command)) {
        local.push({
          severity: "fail",
          code: "COMMAND_NOT_FOUND",
          message: `Command not found on PATH: ${command}`,
          server: server.name,
          file: file.path,
        });
      }

      const base = command.split(/[/\\]/).pop() ?? command;
      if (
        !commandUnresolved &&
        (base === "npx" ||
          base === "npx.cmd" ||
          base === "npx.exe" ||
          base === "npm" ||
          base === "npm.cmd" ||
          base === "npm.exe")
      ) {
        const pkg = extractNpxPackage(command, args);
        if (!pkg) {
          local.push({
            severity: "warn",
            code: "NPX_NO_PACKAGE",
            message: "npx/npm exec invoked without a clear package argument",
            server: server.name,
            file: file.path,
          });
        } else if (!isVersionPinned(pkg)) {
          local.push({
            severity: "warn",
            code: "UNPINNED_PACKAGE",
            message: `Package "${pkg}" is not version-pinned (recommend name@version)`,
            server: server.name,
            file: file.path,
          });
        }
      }

      if (args.some((a) => a.includes("YOUR_") || a.includes("REPLACE_"))) {
        local.push({
          severity: "warn",
          code: "PLACEHOLDER_ARG",
          message: "Args look like unresolved placeholders",
          server: server.name,
          file: file.path,
        });
      }
    }

    const env = server.raw.env;
    if (env && typeof env === "object") {
      for (const [key, value] of Object.entries(
        env as Record<string, string>,
      )) {
        if (
          typeof value === "string" &&
          (value.includes("YOUR_") ||
            value === "" ||
            value.toLowerCase() === "changeme")
        ) {
          local.push({
            severity: "warn",
            code: "PLACEHOLDER_ENV",
            message: `Env ${key} looks unset or placeholder`,
            server: server.name,
            file: file.path,
          });
        }
      }
    }

    for (const f of local) {
      status = worst(status, f.severity);
    }

    if (local.length === 0) {
      local.push({
        severity: "ok",
        code: "HEALTHY",
        message: "No issues detected",
        server: server.name,
        file: file.path,
      });
    }

    findings.push(...local);
    perServer.set(server.name, { status, findings: local });
  }

  return { findings, perServer };
}
