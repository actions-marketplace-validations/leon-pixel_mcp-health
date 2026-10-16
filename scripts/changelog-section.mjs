#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The changelog section for `version`, from its heading through the line before the next version. */
export function changelogSection(markdown, version) {
  const header = `## [${version}]`;
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(header));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## [")) {
      end = i;
      break;
    }
  }
  return `${lines.slice(start, end).join("\n").trim()}\n`;
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const version = process.argv[2];
  const file = process.argv[3] ?? "CHANGELOG.md";
  if (!version) {
    process.stderr.write("usage: changelog-section.mjs <version> [changelog]\n");
    process.exit(1);
  }
  const section = changelogSection(readFileSync(file, "utf8"), version);
  if (!section.trim()) {
    process.stderr.write(`No changelog section for ${version}\n`);
    process.exit(1);
  }
  process.stdout.write(section);
}
