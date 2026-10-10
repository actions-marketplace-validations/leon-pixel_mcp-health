import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

/** Package version. Read from package.json so the CLI and npm stay in step. */
export const VERSION: string = pkg.version;

/** Latest MCP revision that still uses the initialize handshake. */
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";

/** Current stateless MCP revision (per-request _meta, server/discover). */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
