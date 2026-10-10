#!/usr/bin/env node
import { replyToInitialize } from "../support/stdio-reply.mjs";

if (process.env.MCP_HEALTH_MARK !== "ok") {
  process.stderr.write(`bad mark ${process.env.MCP_HEALTH_MARK ?? ""}\n`);
  process.exit(4);
}

replyToInitialize();
