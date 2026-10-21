import { coerce, satisfies, valid, validRange } from "semver";

/** Parse name@version / @scope/name@version into parts. */
export function splitPackageSpec(spec: string): {
  name: string;
  version: string | undefined;
} {
  if (spec.startsWith("@")) {
    const m = spec.match(/^(@[^/]+\/[^@]+)(?:@(.+))?$/);
    if (!m?.[1]) return { name: spec, version: undefined };
    return { name: m[1], version: m[2] };
  }
  const at = spec.indexOf("@");
  if (at <= 0) return { name: spec, version: undefined };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
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
  return validRange(pinned) !== null;
}

/**
 * True when the pinned spec does not accept the registry's latest version.
 * Exact versions drift on inequality. Ranges drift only when latest is outside them.
 */
export function isVersionDrift(pinned: string, latest: string): boolean {
  if (isFloatingPin(pinned)) return true;
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
