import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_CANDIDATES = [
  ".cursor/mcp.json",
  "mcp.json",
  ".mcp.json",
  ".vscode/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".gemini/settings.json",
  ".junie/mcp/mcp.json",
  ".continue/config.yaml",
  ".windsurf/mcp_config.json",
  ".zed/settings.json",
  ".codex/config.toml",
] as const;

const CONTINUE_BLOCK = /\.(yaml|yml|json)$/i;

/** Package-family name of the official Claude Desktop MSIX install. */
const CLAUDE_DESKTOP_MSIX_FAMILY = "Claude_pzs8sxrjxfjjc";

export type LocateOptions = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

function locate(options: LocateOptions = {}): {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    platform: options.platform ?? platform(),
    home: options.home ?? homedir(),
    env: options.env ?? process.env,
  };
}

function claudeDesktopPaths(options: LocateOptions = {}): string[] {
  const { platform: p, home, env } = locate(options);
  if (p === "darwin") {
    return [
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    ];
  }
  if (p === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    const paths = [join(appData, "Claude", "claude_desktop_config.json")];
    // The MSIX build reads a virtualized Roaming file. Skip it when LOCALAPPDATA is unset.
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      paths.push(
        join(
          localAppData,
          "Packages",
          CLAUDE_DESKTOP_MSIX_FAMILY,
          "LocalCache",
          "Roaming",
          "Claude",
          "claude_desktop_config.json",
        ),
      );
    }
    return paths;
  }
  // linux + others
  return [
    join(home, ".config", "Claude", "claude_desktop_config.json"),
  ];
}

function windsurfUserPaths(options: LocateOptions = {}): string[] {
  const { platform: p, home, env } = locate(options);
  const paths = [join(home, ".codeium", "windsurf", "mcp_config.json")];
  if (p === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    paths.push(join(appData, "devin", "mcp_config.json"));
  } else {
    const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
    paths.push(join(xdg, "devin", "mcp_config.json"));
  }
  return paths;
}

function zedUserPaths(options: LocateOptions = {}): string[] {
  const { platform: p, home, env } = locate(options);
  if (p === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "Zed", "settings.json")];
  }
  if (p === "darwin") {
    return [
      join(home, "Library", "Application Support", "Zed", "settings.json"),
      join(home, ".config", "zed", "settings.json"),
    ];
  }
  const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [join(xdg, "zed", "settings.json")];
}

/**
 * Gemini CLI user settings.
 * `GEMINI_CLI_HOME` replaces the home directory; the file is still `.gemini/settings.json`.
 */
function geminiUserPath(options: LocateOptions = {}): string {
  const { home, env } = locate(options);
  const geminiHome = env.GEMINI_CLI_HOME?.trim();
  return join(geminiHome || home, ".gemini", "settings.json");
}

/**
 * VS Code user MCP config opened by "MCP: Open User Configuration".
 * Insiders and VSCodium use different directories and are not scanned.
 */
function vscodeUserMcpPath(options: LocateOptions = {}): string {
  const { platform: p, home, env } = locate(options);
  if (p === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  if (p === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Code", "User", "mcp.json");
  }
  const xdg = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(xdg, "Code", "User", "mcp.json");
}

/** Copilot portable user config. `COPILOT_HOME` replaces `~/.copilot`. */
function copilotUserPath(options: LocateOptions = {}): string {
  const { home, env } = locate(options);
  const copilotHome = env.COPILOT_HOME?.trim();
  if (copilotHome) return join(copilotHome, "mcp-config.json");
  return join(home, ".copilot", "mcp-config.json");
}

/** `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set. */
function claudeCodeUserPath(options: LocateOptions = {}): string {
  const { platform: p, home, env } = locate(options);
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return join(configDir, ".claude.json");
  const userProfile = p === "win32" ? env.USERPROFILE?.trim() : undefined;
  return join(userProfile || home, ".claude.json");
}

/**
 * Cline reads one user file.
 * `CLINE_MCP_SETTINGS_PATH` replaces it.
 * Otherwise `CLINE_DATA_DIR` replaces `~/.cline/data`.
 */
function clineUserPath(options: LocateOptions = {}): string {
  const { home, env } = locate(options);
  const explicit = env.CLINE_MCP_SETTINGS_PATH?.trim();
  if (explicit) return explicit;
  const dataDir = env.CLINE_DATA_DIR?.trim();
  if (dataDir) return join(dataDir, "settings", "cline_mcp_settings.json");
  return join(home, ".cline", "data", "settings", "cline_mcp_settings.json");
}

function continueBlockFiles(root: string): string[] {
  const dir = join(root, ".continue", "mcpServers");
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    if (!CONTINUE_BLOCK.test(name)) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    files.push(full);
  }
  return files;
}

function userLevelPaths(options: LocateOptions = {}): string[] {
  const { home } = locate(options);
  return [
    join(home, ".cursor", "mcp.json"),
    vscodeUserMcpPath(options),
    copilotUserPath(options),
    join(home, ".claude", "settings.json"),
    claudeCodeUserPath(options),
    ...claudeDesktopPaths(options),
    geminiUserPath(options),
    ...windsurfUserPaths(options),
    ...zedUserPaths(options),
    join(home, ".codex", "config.toml"),
    join(home, ".continue", "config.yaml"),
    join(home, ".junie", "mcp", "mcp.json"),
    clineUserPath(options),
  ];
}

export function discoverConfigPaths(
  root: string,
  options: { includeUserConfig?: boolean } & LocateOptions = {},
): string[] {
  const absRoot = resolve(root);
  const found = new Set<string>();

  for (const rel of PROJECT_CANDIDATES) {
    const full = join(absRoot, rel);
    if (existsSync(full)) found.add(full);
  }
  for (const full of continueBlockFiles(absRoot)) {
    found.add(full);
  }

  if (options.includeUserConfig !== false) {
    for (const full of userLevelPaths(options)) {
      if (existsSync(full)) found.add(full);
    }
  }

  return [...found].sort();
}

export const __testing = {
  claudeDesktopPaths,
  claudeCodeUserPath,
  clineUserPath,
  geminiUserPath,
  vscodeUserMcpPath,
  copilotUserPath,
  userLevelPaths,
  PROJECT_CANDIDATES,
};
