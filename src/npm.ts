import { coerce, satisfies, valid, validRange } from "semver";

const PYTHON_NAME = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)/;
const PYTHON_EXTRAS = /^\[[^\]]*\]/;
const PYTHON_OP = /^(===|==|~=|!=|<=|>=|<|>)/;

/**
 * `~=1.4.2` is `>=1.4.2 <1.5.0`. `~=1.4` is `>=1.4.0 <2.0.0`.
 * A non-numeric tail is left for the caller.
 */
function pep440Compatible(version: string): string | undefined {
  const parts = version.split(".");
  if (parts.length < 2 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  if (parts.length === 2) {
    return `>=${parts[0]}.${parts[1]}.0 <${Number(parts[0]) + 1}.0.0`;
  }
  const head = parts.slice(0, -1);
  const last = Number(head[head.length - 1]);
  head[head.length - 1] = String(last + 1);
  return `>=${version} <${head.join(".")}.0`;
}

/**
 * Turn a uv requirement (`==1.2.3`, `>=1,<2`, `~=1.4.2`) into a version
 * or a semver range. Commas become spaces, which is the range separator
 * `semver` accepts. An empty operator is not a pin.
 */
function normalizePinnedVersion(specifiers: string): string | undefined {
  const body = specifiers.trim();
  if (!body) return undefined;
  const exact = body.match(/^(?:===|==)\s*(\S+)$/);
  if (exact?.[1]) return exact[1];
  const compatible = body.match(/^~=\s*([0-9]+(?:\.[0-9]+)*)\s*$/);
  if (compatible?.[1]) return pep440Compatible(compatible[1]) ?? body;
  const normalized = body.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!/(?:===|==|~=|!=|<=|>=|<|>)\s*\S/.test(normalized)) return undefined;
  return normalized;
}

/**
 * uv requirement: `name==1.2.3`, `name[extra]>=1.0`, `name>=1,<2`.
 * A marker after `;` is not part of the version. npm `name@version` does not match.
 */
function splitPythonRequirement(
  spec: string,
): { name: string; version: string } | undefined {
  const withoutMarker = spec.split(";")[0]?.trim() ?? "";
  const nameMatch = PYTHON_NAME.exec(withoutMarker);
  if (!nameMatch?.[1]) return undefined;
  let rest = withoutMarker.slice(nameMatch[1].length).trim();
  if (PYTHON_EXTRAS.test(rest)) rest = rest.replace(PYTHON_EXTRAS, "").trim();
  if (!PYTHON_OP.test(rest)) return undefined;
  const version = normalizePinnedVersion(rest);
  if (!version) return undefined;
  return { name: nameMatch[1], version };
}

/** Parse name@version / @scope/name@version, and a uv requirement, into parts. */
export function splitPackageSpec(spec: string): {
  name: string;
  version: string | undefined;
} {
  const trimmed = spec.trim();
  const python = splitPythonRequirement(trimmed);
  if (python) return python;
  if (trimmed.startsWith("@")) {
    const m = trimmed.match(/^(@[^/]+\/[^@]+)(?:@(.+))?$/);
    if (!m?.[1]) return { name: trimmed, version: undefined };
    return { name: m[1], version: m[2] };
  }
  const at = trimmed.indexOf("@");
  if (at <= 0) return { name: trimmed, version: undefined };
  return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) };
}

const FLOATING = new Set(["latest", "next", "*"]);

/** `latest`, `next`, and `*` float. The comparison is case-insensitive. */
export function isFloatingPin(version: string): boolean {
  return FLOATING.has(version.toLowerCase());
}

function latestVersion(version: string): string | null {
  return valid(version) ?? valid(coerce(version));
}

/** True when the pin is a semver range rather than one exact version. */
export function isRangePin(pinned: string): boolean {
  if (isFloatingPin(pinned)) return false;
  if (valid(pinned)) return false;
  if (validRange(pinned) !== null) return true;
  return /^(?:!=|<=|>=|<|>|~=)/.test(pinned);
}

/**
 * True when the pinned spec does not accept the registry's latest version.
 * Exact versions drift on inequality. Ranges drift only when latest is outside them.
 * `!=1.2.3` drifts only when latest is that excluded version.
 */
export function isVersionDrift(pinned: string, latest: string): boolean {
  if (isFloatingPin(pinned)) return true;
  const excluded = pinned.match(/^!=\s*(.+)$/);
  if (excluded?.[1]) {
    const banned = excluded[1].trim();
    const latestClean = latestVersion(latest);
    const bannedClean = latestVersion(banned);
    if (latestClean && bannedClean) return latestClean === bannedClean;
    return latest.trim() === banned;
  }
  const latestClean = latestVersion(latest);
  if (!latestClean) return pinned !== latest;
  const range = validRange(pinned);
  if (range && satisfies(latestClean, range)) return false;
  return true;
}

export type NpmLatestResult =
  | { ok: true; name: string; latest: string }
  | { ok: false; name: string; error: string };

export async function fetchNpmLatest(
  name: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<NpmLatestResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return {
        ok: false,
        name,
        error: `npm registry HTTP ${res.status} for ${name}`,
      };
    }
    const body = (await res.json()) as { version?: string };
    if (!body.version) {
      return { ok: false, name, error: `No version in npm latest for ${name}` };
    }
    return { ok: true, name, latest: body.version };
  } catch (err) {
    return {
      ok: false,
      name,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function pypiErrorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err.cause : undefined;
  const code =
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof cause.code === "string"
      ? cause.code
      : undefined;
  if (code && !message.includes(code)) return `${message}: ${code}`;
  return message;
}

/**
 * Latest release on PyPI. `info.version` in the project JSON is that release.
 * Requirement specifiers are not part of `name`.
 */
export async function fetchPypiLatest(
  name: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<NpmLatestResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort);

  try {
    const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return {
        ok: false,
        name,
        error: `PyPI HTTP ${res.status} for ${name}`,
      };
    }
    const body = (await res.json()) as { info?: { version?: unknown } };
    const version = body?.info?.version;
    if (typeof version !== "string" || version.trim() === "") {
      return { ok: false, name, error: `No version in PyPI latest for ${name}` };
    }
    return { ok: true, name, latest: version.trim() };
  } catch (err) {
    if (timedOut) {
      return { ok: false, name, error: `PyPI lookup timed out for ${name}` };
    }
    return {
      ok: false,
      name,
      error: `PyPI lookup failed for ${name}: ${pypiErrorDetail(err)}`,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
