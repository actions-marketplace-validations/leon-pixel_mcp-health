import type { ConfigFile, Finding, ParsedServer, Severity } from "./types.js";
import { accessSync, constants, existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { lookupEnv } from "./vars.js";

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

function findInDir(
  dir: string,
  names: string[],
  platform: NodeJS.Platform,
): string | undefined {
  for (const name of names) {
    const full = join(dir, name);
    if (isRunnable(full, platform)) return full;
  }
  return undefined;
}

/**
 * Resolve a command the way the host shell would.
 * On Windows, `npx` is `npx.cmd` / `npx.exe` and is found via PATHEXT.
 * A relative command is resolved from `cwd` (the scan root).
 * On Windows that directory is searched before PATH.
 * An empty PATH entry means that directory on every platform.
 * Returns an absolute path when the command is found.
 */
export function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): string | undefined {
  const base = cwd && cwd.trim() ? resolve(cwd) : process.cwd();
  const extensions = pathExtensions(env, platform);
  const names =
    platform === "win32" && !hasPathExtension(command, extensions)
      ? extensions.map((ext) => `${command}${ext}`)
      : [command];

  const direct =
    isAbsolute(command) || command.includes("/") || command.includes("\\");
  if (direct) {
    for (const name of names) {
      const candidate = isAbsolute(name) ? name : join(base, name);
      if (isRunnable(candidate, platform)) return candidate;
    }
    return undefined;
  }

  if (platform === "win32") {
    const fromCwd = findInDir(base, names, platform);
    if (fromCwd) return fromCwd;
  }

  if (env.PATH === undefined) return undefined;
  for (const dir of env.PATH.split(pathDelimiter(platform))) {
    const fromDir = dir
      ? findInDir(dir, names, platform)
      : findInDir(base, names, platform);
    if (fromDir) return fromDir;
  }
  return undefined;
}

function commandOnPath(command: string, cwd?: string): boolean {
  return (
    resolveCommandOnPath(command, process.env, process.platform, cwd) !==
    undefined
  );
}

function unresolvedTokens(value: string): string[] {
  return value.match(UNRESOLVED_VAR) ?? [];
}

/** Cursor `disabled: true`, or Codex/Zed `enabled: false`. */
export function isServerDisabled(server: ParsedServer): boolean {
  return server.raw.disabled === true || server.raw.enabled === false;
}

/**
 * Zed extension context servers have `source: "extension"`, or the untagged
 * settings shape (a `settings` object and no command or URL). The extension
 * launches the process. A custom server with only `env` is not this.
 */
export function isExtensionProvided(server: ParsedServer): boolean {
  if (server.raw.source === "extension") return true;
  if (server.raw.source === "custom") return false;
  const settings = server.raw.settings;
  const settingsObject =
    settings !== null && typeof settings === "object" && !Array.isArray(settings);
  return settingsObject && server.transport.kind === "unknown";
}

function collectUnresolved(server: ParsedServer): string[] {
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
  return hits;
}

export function serverHasUnresolved(server: ParsedServer): boolean {
  return collectUnresolved(server).length > 0;
}

/** `${input:…}` and unset `${env:…}` are IDE or secret references, not typos. */
function softUnresolved(token: string): boolean {
  return /^\$\{input:/i.test(token) || /^\$\{env:/i.test(token);
}

function unresolvedVariableFinding(
  server: ParsedServer,
  file: string,
  strict: boolean,
): Finding | undefined {
  const hits = collectUnresolved(server);
  if (hits.length === 0) return undefined;
  const hard = hits.some((hit) => !softUnresolved(hit.slice(0, hit.indexOf(" in "))));
  const severity: Severity = hard || strict ? "fail" : "warn";
  const note = strict
    ? " --strict-variables is set"
    : " ${input:…} and unset ${env:…} are warnings; other ${…} tokens fail";
  return {
    severity,
    code: "UNRESOLVED_VARIABLE",
    message: `Unresolved config variable ${hits.join("; ")}.${note}`,
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

/** `npx`, `npx.cmd`, and `C:\\path\\npx.exe` all share one launcher name. */
function commandBasename(command: string): string {
  const base = command.split(/[/\\]/).pop() ?? command;
  return base.replace(/\.(cmd|exe)$/i, "");
}

const PACKAGE_RUNNERS = new Set(["npx", "npm", "uvx", "bunx", "pnpm", "yarn"]);

/**
 * Flags whose next argument is not the package.
 * `uvx -p` is a Python version. `npx -p` is the package, so it is not listed here.
 */
const NON_PACKAGE_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  uvx: new Set([
    "--with",
    "--with-editable",
    "--with-requirements",
    "--python",
    "-p",
    "--index",
    "--default-index",
    "--index-url",
    "--extra-index-url",
    "--find-links",
    "--config-file",
    "--python-preference",
    "--keyring-provider",
    "--index-strategy",
    "--prerelease",
  ]),
  pnpm: new Set(["--config", "--reporter", "--dir", "-C"]),
};

function explicitFromPackage(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "--from") {
      const next = args[i + 1];
      if (next && next !== "--" && !next.startsWith("-")) return next;
      continue;
    }
    if (arg.startsWith("--from=")) {
      const value = arg.slice("--from=".length);
      if (value) return value;
    }
  }
  return undefined;
}

function firstPackageArg(args: string[], launcher: string): string | undefined {
  const skipValue = NON_PACKAGE_VALUE_FLAGS[launcher];
  const skipSubcommand = launcher === "pnpm" || launcher === "yarn";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--" || arg === "--from") continue;
    if (arg.startsWith("--from=")) continue;
    if (skipValue?.has(arg)) {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (skipSubcommand && (arg === "dlx" || arg === "exec")) continue;
    return arg;
  }
  return undefined;
}

/**
 * Package spec launched by npx, npm exec, uvx, bunx, pnpm dlx, pnpm exec, or yarn dlx.
 * `--from <spec>` wins. Flags (`-y`, `--yes`, `--quiet`) and the `dlx` / `exec`
 * subcommands are not the package.
 */
export function extractNpxPackage(command: string, args: string[]): string | undefined {
  const base = commandBasename(command);
  if (!PACKAGE_RUNNERS.has(base)) return undefined;

  let rest = args;
  if (base === "npm") {
    const execIdx = rest.indexOf("exec");
    if (execIdx === -1) return undefined;
    rest = rest.slice(execIdx + 1);
  } else if (base === "pnpm") {
    const idx = rest.findIndex((arg) => arg === "dlx" || arg === "exec");
    if (idx === -1) return undefined;
    rest = rest.slice(idx + 1);
  } else if (base === "yarn") {
    const idx = rest.indexOf("dlx");
    if (idx === -1) return undefined;
    rest = rest.slice(idx + 1);
  }

  return explicitFromPackage(rest) ?? firstPackageArg(rest, base);
}

function worst(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { ok: 0, warn: 1, fail: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function checkConfig(
  file: ConfigFile,
  options: { strictVariables?: boolean; cwd?: string } = {},
): {
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

    if (isServerDisabled(server)) {
      local.push({
        severity: "ok",
        code: "DISABLED",
        message: "Disabled in config; not checked",
        server: server.name,
        file: file.path,
      });
      findings.push(...local);
      perServer.set(server.name, { status: "ok", findings: local });
      continue;
    }

    if (isExtensionProvided(server)) {
      local.push({
        severity: "ok",
        code: "EXTENSION_SERVER",
        message: "Extension-provided server; the extension launches it",
        server: server.name,
        file: file.path,
      });
      findings.push(...local);
      perServer.set(server.name, { status: "ok", findings: local });
      continue;
    }

    if (!server.name.trim()) {
      local.push({
        severity: "fail",
        code: "EMPTY_NAME",
        message: "Server name is empty",
        server: server.name,
        file: file.path,
      });
    }

    const unresolved = unresolvedVariableFinding(
      server,
      file.path,
      Boolean(options.strictVariables),
    );
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

      if (!commandUnresolved && !commandOnPath(command, options.cwd)) {
        local.push({
          severity: "fail",
          code: "COMMAND_NOT_FOUND",
          message: `Command not found on PATH: ${command}`,
          server: server.name,
          file: file.path,
        });
      }

      const base = commandBasename(command);
      if (!commandUnresolved && PACKAGE_RUNNERS.has(base)) {
        const pkg = extractNpxPackage(command, args);
        if (!pkg) {
          // pnpm/yarn without dlx or exec are not package launches.
          if (base === "npx" || base === "npm") {
            local.push({
              severity: "warn",
              code: "NPX_NO_PACKAGE",
              message: "npx/npm exec invoked without a clear package argument",
              server: server.name,
              file: file.path,
            });
          }
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

    const bearer = server.raw.bearerTokenEnvVar;
    const authEnvNames: string[] = [];
    if (typeof bearer === "string" && bearer.trim()) authEnvNames.push(bearer.trim());
    const envHeaders = server.raw.envHttpHeaders;
    if (envHeaders && typeof envHeaders === "object" && !Array.isArray(envHeaders)) {
      for (const envName of Object.values(envHeaders)) {
        if (typeof envName === "string" && envName.trim()) authEnvNames.push(envName.trim());
      }
    }
    for (const envName of authEnvNames) {
      if (lookupEnv(envName, process.env, process.platform) === undefined) {
        local.push({
          severity: "warn",
          code: "AUTH_ENV_UNSET",
          message: `Auth env ${envName} is not set`,
          server: server.name,
          file: file.path,
        });
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
