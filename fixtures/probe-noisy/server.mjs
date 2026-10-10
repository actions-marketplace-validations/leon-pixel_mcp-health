#!/usr/bin/env node
import { replyToInitialize } from "../support/stdio-reply.mjs";

process.stdout.write("starting up\n");
process.stdout.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/message",
    params: { level: "info", data: "hi" },
  })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 99,
    error: { message: "wrong id" },
  })}\n`,
);

replyToInitialize();
