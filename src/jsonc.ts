/**
 * Parse JSONC the way VS Code and Zed accept settings: comments and
 * trailing commas, without treating comment markers inside strings as comments.
 */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err));
  }
}

function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";

    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      i += 1;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i = Math.min(text.length, i + 2);
      continue;
    }

    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j += 1;
      const closer = text[j] ?? "";
      if (closer === "}" || closer === "]") {
        i += 1;
        continue;
      }
    }

    out += c;
    i += 1;
  }

  return out;
}
