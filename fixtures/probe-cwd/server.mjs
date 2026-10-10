#!/usr/bin/env node
import { basename } from "node:path";
import { replyToInitialize } from "../support/stdio-reply.mjs";

if (basename(process.cwd()) !== "probe-cwd") {
  process.stderr.write(`unexpected cwd ${process.cwd()}\n`);
  process.exit(4);
}

replyToInitialize();
