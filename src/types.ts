export type Severity = "ok" | "warn" | "fail";

export type ServerTransport =
  | { kind: "stdio"; command: string; args: string[] }
  | { kind: "http"; url: string }
  | { kind: "unknown" };

export type ParsedServer = {
  name: string;
  transport: ServerTransport;
  raw: Record<string, unknown>;
};

export type ConfigFile = {
  path: string;
  format:
    | "mcpServers"
    | "servers"
    | "contextServers"
    | "codex"
    | "none"
    | "unknown"
    | "invalid";
  servers: ParsedServer[];
  /** Set when format is "invalid". */
  error?: string;
};

export type Finding = {
  severity: Severity;
  code: string;
  message: string;
  server?: string;
  file?: string;
};

export type ConfigScope = "project" | "user";

export type ServerReport = {
  name: string;
  file: string;
  transport: ServerTransport["kind"];
  status: Severity;
  findings: Finding[];
  /**
   * `project` for a repository config, `user` for a user-level file.
   * Omitted on a scan-level row such as `NO_CONFIG`.
   */
  scope?: ConfigScope;
};

export type HealthReport = {
  scannedAt: string;
  root: string;
  files: string[];
  servers: ServerReport[];
  summary: {
    ok: number;
    warn: number;
    fail: number;
    files: number;
    servers: number;
    /** Settings files with no MCP section. Not included in ok/warn/fail. */
    skipped: number;
    /**
     * Warnings on a config file that are not server rows, such as EMPTY_SERVERS.
     * Not included in `warn`, so `ok + warn + fail` still equals `servers`.
     */
    configWarnings: number;
  };
};
