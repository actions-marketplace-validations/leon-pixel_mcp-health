import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isVersionPinned } from "./check.js";
import { fetchPypiLatest, isRangePin, isVersionDrift, splitPackageSpec } from "./npm.js";
import { exitCode } from "./report.js";
import { runCheck } from "./run.js";

function putUvxOnPath(dir: string): string | undefined {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const uvx = join(bin, "uvx");
  writeFileSync(uvx, "#!/bin/sh\nexit 0\n");
  chmodSync(uvx, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = previous ? `${bin}:${previous}` : bin;
  return previous;
}

describe("uv requirement pins", () => {
  it("splits ==, extras, markers, and ranges without touching npm specs", () => {
    expect(splitPackageSpec("bitbucket-mcp-py==1.8.0")).toEqual({
      name: "bitbucket-mcp-py",
      version: "1.8.0",
    });
    expect(splitPackageSpec("  mcp-server-git == 1.2.3  ")).toEqual({
      name: "mcp-server-git",
      version: "1.2.3",
    });
    expect(splitPackageSpec("pkg===1.2.3")).toEqual({
      name: "pkg",
      version: "1.2.3",
    });
    expect(splitPackageSpec("mypy[faster-cache,reports]==1.13.0")).toEqual({
      name: "mypy",
      version: "1.13.0",
    });
    expect(splitPackageSpec("pkg==1.2.3; python_version>='3.10'")).toEqual({
      name: "pkg",
      version: "1.2.3",
    });
    expect(splitPackageSpec("ruff>=0.2.0,<0.3.0")).toEqual({
      name: "ruff",
      version: ">=0.2.0 <0.3.0",
    });
    expect(splitPackageSpec("ruff>0.2.0,<0.3.0")).toEqual({
      name: "ruff",
      version: ">0.2.0 <0.3.0",
    });
    expect(splitPackageSpec("pkg!=1.2.3")).toEqual({
      name: "pkg",
      version: "!=1.2.3",
    });
    expect(splitPackageSpec("pkg~=1.4.2")).toEqual({
      name: "pkg",
      version: ">=1.4.2 <1.5.0",
    });
    expect(splitPackageSpec("pkg~=1.4")).toEqual({
      name: "pkg",
      version: ">=1.4.0 <2.0.0",
    });

    expect(splitPackageSpec("lodash@4.17.21")).toEqual({
      name: "lodash",
      version: "4.17.21",
    });
    expect(splitPackageSpec("@a/b@1.2.3")).toEqual({
      name: "@a/b",
      version: "1.2.3",
    });
    expect(splitPackageSpec("@scope/pkg")).toEqual({
      name: "@scope/pkg",
      version: undefined,
    });
    expect(splitPackageSpec("mcp-server-git")).toEqual({
      name: "mcp-server-git",
      version: undefined,
    });
    expect(splitPackageSpec("pkg@>=1.0.0")).toEqual({
      name: "pkg",
      version: ">=1.0.0",
    });
  });

  it("treats a requirement as pinned and leaves floating tags unpinned", () => {
    expect(isVersionPinned("bitbucket-mcp-py==1.8.0")).toBe(true);
    expect(isVersionPinned("mypy[faster-cache]==1.13.0")).toBe(true);
    expect(isVersionPinned("ruff>=0.2.0,<0.3.0")).toBe(true);
    expect(isVersionPinned("pkg~=1.4.2")).toBe(true);
    expect(isVersionPinned("pkg!=1.2.3")).toBe(true);
    expect(isVersionPinned("pkg==latest")).toBe(false);
    expect(isVersionPinned("pkg==Latest")).toBe(false);
    expect(isVersionPinned("pkg==next")).toBe(false);
    expect(isVersionPinned("pkg==*")).toBe(false);
    expect(isVersionPinned("pkg")).toBe(false);
    expect(isVersionPinned("some-server@latest")).toBe(false);
    expect(isVersionPinned("@playwright/mcp@1.2.3")).toBe(true);

    expect(isRangePin(">=0.2.0 <0.3.0")).toBe(true);
    expect(isRangePin("1.8.0")).toBe(false);
    expect(isVersionDrift("1.8.0", "1.8.0")).toBe(false);
    expect(isVersionDrift("1.8.0", "1.9.0")).toBe(true);
    expect(isVersionDrift(">=0.2.0 <0.3.0", "0.2.9")).toBe(false);
    expect(isVersionDrift(">=0.2.0 <0.3.0", "0.3.0")).toBe(true);
    expect(isVersionDrift(">=1.4.2 <1.5.0", "1.4.5")).toBe(false);
    expect(isVersionDrift(">=1.4.2 <1.5.0", "1.5.0")).toBe(true);
    expect(isVersionDrift(">=1.4.0 <2.0.0", "1.9.0")).toBe(false);
    expect(isVersionDrift("!=1.2.3", "1.2.4")).toBe(false);
    expect(isVersionDrift("!=1.2.3", "1.2.3")).toBe(true);
  });

  it("does not warn UNPINNED_PACKAGE for a uvx requirement and does not rewrite the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-uvx-pin-"));
    const file = join(dir, "mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        "eq-pin": {
          command: "uvx",
          args: ["--from", "bitbucket-mcp-py==1.8.0", "bitbucket-mcp"],
        },
        "range-pin": {
          command: "uvx",
          args: ["--from", "ruff>=0.2.0,<0.3.0", "ruff"],
        },
        "extra-pin": {
          command: "uvx",
          args: ["mypy[faster-cache]==1.13.0"],
        },
        loose: { command: "uvx", args: ["mcp-server-git"] },
        "float-eq": { command: "uvx", args: ["mcp-server-git==latest"] },
        "npm-float": { command: "npx", args: ["-y", "some-server@latest"] },
        "npm-pin": { command: "npx", args: ["-y", "some-server@1.2.3"] },
      },
    });
    writeFileSync(file, original);
    try {
      const report = await runCheck({ root: dir, includeUserConfig: false, env: {} });
      const codes = (name: string) =>
        report.servers
          .find((server) => server.name === name)
          ?.findings.map((finding) => finding.code) ?? [];
      expect(codes("eq-pin")).not.toContain("UNPINNED_PACKAGE");
      expect(codes("range-pin")).not.toContain("UNPINNED_PACKAGE");
      expect(codes("extra-pin")).not.toContain("UNPINNED_PACKAGE");
      expect(codes("loose")).toContain("UNPINNED_PACKAGE");
      expect(codes("float-eq")).toContain("UNPINNED_PACKAGE");
      expect(codes("npm-float")).toContain("UNPINNED_PACKAGE");
      expect(codes("npm-pin")).not.toContain("UNPINNED_PACKAGE");
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("looks up uvx on PyPI and keeps npx, bunx, pnpm, and yarn on npm", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-uvx-online-"));
    const file = join(dir, "mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        current: {
          command: "uvx",
          args: ["--from", "current-pkg==1.2.3", "current-pkg"],
        },
        drift: { command: "uvx", args: ["drift-pkg==1.0.0"] },
        "range-in": {
          command: "uvx",
          args: ["--from", "range-pkg>=1.0,<2", "range-pkg"],
        },
        "range-out": { command: "uvx", args: ["range-out>=2"] },
        "at-least": { command: "uvx", args: ["at-least-pkg>=1"] },
        extras: { command: "uvx", args: ["mypy[faster-cache]==1.13.0"] },
        loose: { command: "uvx", args: ["loose-pkg"] },
        missing: {
          command: "uvx",
          args: ["--from", "missing-pkg==1.0.0", "missing-pkg"],
        },
        "npm-current": { command: "npx", args: ["-y", "some-npm@2.0.0"] },
        "npm-drift": { command: "npx", args: ["-y", "other-npm@1.0.0"] },
        "bunx-current": { command: "bunx", args: ["bun-pkg@1.2.3"] },
        "pnpm-current": { command: "pnpm", args: ["dlx", "pnpm-pkg@3.1.0"] },
        "yarn-current": { command: "yarn", args: ["dlx", "yarn-pkg@4.0.0"] },
      },
    });
    writeFileSync(file, original);
    const previousPath = putUvxOnPath(dir);

    const versions: Record<string, string> = {
      "current-pkg": "1.2.3",
      "drift-pkg": "3.0.0",
      "range-pkg": "1.5.0",
      "range-out": "1.9.0",
      "at-least-pkg": "1.4.0",
      mypy: "1.13.0",
      "loose-pkg": "4.4.4",
      "some-npm": "2.0.0",
      "other-npm": "2.0.0",
      "bun-pkg": "1.2.3",
      "pnpm-pkg": "3.1.0",
      "yarn-pkg": "4.0.0",
    };
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://registry.npmjs.org/")) {
        const name = decodeURIComponent(
          url.slice("https://registry.npmjs.org/".length).replace(/\/latest$/, ""),
        );
        const version = versions[name];
        if (!version) return new Response("missing", { status: 404 });
        return new Response(JSON.stringify({ version }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("https://pypi.org/pypi/") && url.endsWith("/json")) {
        const name = decodeURIComponent(
          url.slice("https://pypi.org/pypi/".length, -"/json".length),
        );
        if (name === "missing-pkg") return new Response("no such project", { status: 404 });
        const version = versions[name];
        if (!version) return new Response("missing", { status: 404 });
        return new Response(JSON.stringify({ info: { version } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });

    try {
      const report = await runCheck({
        root: dir,
        includeUserConfig: false,
        env: {},
        online: true,
      });
      const finding = (name: string, code: string) =>
        report.servers
          .find((server) => server.name === name)
          ?.findings.find((item) => item.code === code);
      const message = (name: string, code: string) => finding(name, code)?.message;

      expect(urls).toContain("https://pypi.org/pypi/current-pkg/json");
      expect(urls).toContain("https://pypi.org/pypi/drift-pkg/json");
      expect(urls).toContain("https://pypi.org/pypi/range-pkg/json");
      expect(urls).toContain("https://pypi.org/pypi/at-least-pkg/json");
      expect(urls).toContain("https://pypi.org/pypi/mypy/json");
      expect(urls).toContain("https://pypi.org/pypi/loose-pkg/json");
      expect(urls).toContain("https://pypi.org/pypi/missing-pkg/json");
      expect(urls).not.toContain("https://registry.npmjs.org/current-pkg/latest");
      expect(urls).not.toContain("https://registry.npmjs.org/mypy/latest");
      expect(urls.some((url) => url.includes("==") || url.includes(">=") || url.includes("["))).toBe(
        false,
      );
      expect(urls).toContain("https://registry.npmjs.org/some-npm/latest");
      expect(urls).toContain("https://registry.npmjs.org/other-npm/latest");
      expect(urls).toContain("https://registry.npmjs.org/bun-pkg/latest");
      expect(urls).toContain("https://registry.npmjs.org/pnpm-pkg/latest");
      expect(urls).toContain("https://registry.npmjs.org/yarn-pkg/latest");
      expect(urls).not.toContain("https://pypi.org/pypi/some-npm/json");
      expect(urls).not.toContain("https://pypi.org/pypi/bun-pkg/json");

      expect(message("current", "NPM_CURRENT")).toBe("Pinned 1.2.3 matches PyPI latest");
      expect(message("drift", "NPM_DRIFT")).toBe("Pinned 1.0.0 but PyPI latest is 3.0.0");
      expect(message("range-in", "NPM_CURRENT")).toBe(
        "Pinned range >=1.0 <2 includes PyPI latest 1.5.0",
      );
      expect(message("range-out", "NPM_DRIFT")).toBe(
        "Pinned range >=2 does not include PyPI latest 1.9.0",
      );
      expect(message("at-least", "NPM_CURRENT")).toBe(
        "Pinned range >=1 includes PyPI latest 1.4.0",
      );
      expect(message("extras", "NPM_CURRENT")).toBe("Pinned 1.13.0 matches PyPI latest");
      expect(message("loose", "NPM_LATEST")).toBe(
        "Unpinned; PyPI latest is 4.4.4 (pin loose-pkg@4.4.4)",
      );
      expect(message("missing", "NPM_LOOKUP_FAILED")).toBe("PyPI HTTP 404 for missing-pkg");
      expect(finding("missing", "NPM_LOOKUP_FAILED")?.severity).toBe("warn");
      expect(report.servers.find((server) => server.name === "missing")?.status).toBe("warn");
      expect(report.servers.find((server) => server.name === "current")?.status).toBe("ok");
      expect(report.servers.find((server) => server.name === "drift")?.status).toBe("warn");

      for (const name of ["current", "drift", "range-in", "range-out", "at-least", "extras", "loose", "missing"]) {
        const text = report.servers
          .find((server) => server.name === name)
          ?.findings.map((item) => item.message)
          .join("\n");
        expect(text, name).not.toContain("npm registry");
        expect(text, name).not.toContain("registry.npmjs.org");
      }

      expect(message("npm-current", "NPM_CURRENT")).toBe("Pinned 2.0.0 matches npm latest");
      expect(message("npm-drift", "NPM_DRIFT")).toBe("Pinned 1.0.0 but npm latest is 2.0.0");
      expect(message("bunx-current", "NPM_CURRENT")).toBe("Pinned 1.2.3 matches npm latest");
      expect(message("pnpm-current", "NPM_CURRENT")).toBe("Pinned 3.1.0 matches npm latest");
      expect(message("yarn-current", "NPM_CURRENT")).toBe("Pinned 4.0.0 matches npm latest");
      for (const name of ["npm-current", "npm-drift", "bunx-current", "pnpm-current", "yarn-current"]) {
        const text = report.servers
          .find((server) => server.name === name)
          ?.findings.map((item) => item.message)
          .join("\n");
        expect(text, name).not.toContain("PyPI");
      }

      expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns with a PyPI message when the registry cannot be reached", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-uvx-offline-"));
    const file = join(dir, "mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        git: { command: "uvx", args: ["--from", "mcp-server-git==1.2.3", "mcp-server-git"] },
      },
    });
    writeFileSync(file, original);
    const previousPath = putUvxOnPath(dir);
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    try {
      const report = await runCheck({
        root: dir,
        includeUserConfig: false,
        env: {},
        online: true,
      });
      const failed = report.servers
        .find((server) => server.name === "git")
        ?.findings.find((finding) => finding.code === "NPM_LOOKUP_FAILED");
      expect(failed?.severity).toBe("warn");
      expect(failed?.message).toBe(
        "PyPI lookup failed for mcp-server-git: fetch failed: ENOTFOUND",
      );
      expect(failed?.message).not.toContain("npm");
      expect(report.servers.find((server) => server.name === "git")?.status).toBe("warn");
      expect(exitCode(report)).toBe(1);
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads info.version and names PyPI when the project JSON is unusable", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/ok-pkg/json")) {
        return new Response(JSON.stringify({ info: { version: " 1.2.3 " } }), { status: 200 });
      }
      if (url.endsWith("/npm-shape/json")) {
        return new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 });
      }
      if (url.endsWith("/broken/json")) {
        return new Response("not-json", { status: 200 });
      }
      if (url.endsWith("/missing/json")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      return new Response("no", { status: 500 });
    });
    try {
      await expect(fetchPypiLatest("ok-pkg")).resolves.toEqual({
        ok: true,
        name: "ok-pkg",
        latest: "1.2.3",
      });
      await expect(fetchPypiLatest("npm-shape")).resolves.toEqual({
        ok: false,
        name: "npm-shape",
        error: "No version in PyPI latest for npm-shape",
      });
      await expect(fetchPypiLatest("broken")).resolves.toMatchObject({
        ok: false,
        name: "broken",
      });
      const broken = await fetchPypiLatest("broken");
      expect(broken.ok).toBe(false);
      if (!broken.ok) {
        expect(broken.error).toContain("PyPI lookup failed for broken");
        expect(broken.error).not.toContain("npm");
      }
      await expect(fetchPypiLatest("missing")).resolves.toEqual({
        ok: false,
        name: "missing",
        error: "PyPI HTTP 404 for missing",
      });
      await expect(fetchPypiLatest("down")).resolves.toEqual({
        ok: false,
        name: "down",
        error: "PyPI HTTP 500 for down",
      });
      expect(urls).toContain("https://pypi.org/pypi/ok-pkg/json");
      expect(urls.every((url) => url.startsWith("https://pypi.org/pypi/"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("times out a PyPI lookup without calling npm", async () => {
    vi.stubGlobal(
      "fetch",
      (_input: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    try {
      const result = await fetchPypiLatest("slow-pkg", { timeoutMs: 30 });
      expect(result).toEqual({
        ok: false,
        name: "slow-pkg",
        error: "PyPI lookup timed out for slow-pkg",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
