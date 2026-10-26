import { splitPackageSpec } from "./npm.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One line, so a hint cannot break the human report or an annotation. */
function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
}

/**
 * `${env:NAME}` is safe to paste. A key that is not an env name gets no
 * sample value, so the hint cannot hand back a placeholder or a secret.
 */
function envSnippet(field: "env" | "headers" | "auth", key: string): string {
  const name = oneLine(key);
  if (!IDENTIFIER.test(name)) {
    return `Replace ${field} ${JSON.stringify(name)} with a real value.`;
  }
  const snippet = `${JSON.stringify(name)}: ${JSON.stringify("${env:" + name + "}")}`;
  return `Replace ${field} ${JSON.stringify(name)} with a real value, or paste ${snippet}.`;
}

export function commandNotFoundHint(command: string): string {
  const shown = oneLine(command);
  return `Install ${JSON.stringify(shown)} so it is on PATH, or change "command" to a program that is already installed.`;
}

/** The argument to paste in place of an unpinned spec. Floating tags are dropped. */
export function unpinnedPackageHint(pkg: string): string {
  const { name, version } = splitPackageSpec(pkg);
  const pinned = version ? `${name}@<version>` : `${oneLine(pkg)}@<version>`;
  return `Change the package argument to ${JSON.stringify(oneLine(pinned))}.`;
}

export function badUrlHint(field: string): string {
  return `Set ${JSON.stringify(field)} to an absolute URL such as "https://example.com/mcp".`;
}

export function badUrlProtocolHint(field: string, protocol: string): string {
  const shown = /^[a-z0-9.+-]+:$/i.test(protocol) ? protocol : "unsupported";
  return `Replace the ${shown} value of ${JSON.stringify(field)} with a supported URL such as "https://example.com/mcp".`;
}

export function placeholderEnvHint(key: string): string {
  return envSnippet("env", key);
}

export function placeholderHeaderHint(
  field: "headers" | "auth",
  key: string,
): string {
  return envSnippet(field, key);
}

export function envFileMissingHint(filePath: string): string {
  return `Create ${JSON.stringify(oneLine(filePath))}, or set "envFile" to a file that exists.`;
}

export function noTransportHint(): string {
  return 'Add a stdio "command" (for example "command": "npx", "args": ["-y", "package@<version>"]) or a remote "url" (for example "url": "https://example.com/mcp").';
}

export function missingTransportTypeHint(): string {
  return 'Paste "type": "http" next to "url" ("sse", "ws", and "streamable-http" also work).';
}
