import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_CANDIDATES = [
  ".cursor/mcp.json",
  "mcp.json",
  ".mcp.json",
  ".vscode/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".windsurf/mcp_config.json",
  ".zed/settings.json",
  ".codex/config.toml",
] as const;

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

function userLevelPaths(options: LocateOptions = {}): string[] {
  const { home } = locate(options);
  return [
    join(home, ".cursor", "mcp.json"),
    join(home, ".claude", "settings.json"),
    ...claudeDesktopPaths(options),
    ...windsurfUserPaths(options),
    ...zedUserPaths(options),
    join(home, ".codex", "config.toml"),
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

  if (options.includeUserConfig !== false) {
    for (const full of userLevelPaths(options)) {
      if (existsSync(full)) found.add(full);
    }
  }

  return [...found].sort();
}

export const __testing = { claudeDesktopPaths, userLevelPaths, PROJECT_CANDIDATES };
