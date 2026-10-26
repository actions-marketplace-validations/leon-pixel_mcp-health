import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isVersionPinned } from "./check.js";
import { isRangePin, isVersionDrift, splitPackageSpec } from "./npm.js";
import { runCheck } from "./run.js";

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

  it("looks up the distribution name, not the == spec, when --online is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-uvx-online-"));
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ version: "1.8.0" }), { status: 200 });
    });
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          pinned: {
            command: "uvx",
            args: ["--from", "bitbucket-mcp-py==1.8.0", "bitbucket-mcp"],
          },
        },
      }),
    );
    try {
      const report = await runCheck({
        root: dir,
        includeUserConfig: false,
        env: {},
        online: true,
      });
      const codes =
        report.servers
          .find((server) => server.name === "pinned")
          ?.findings.map((finding) => finding.code) ?? [];
      expect(urls).toEqual(["https://registry.npmjs.org/bitbucket-mcp-py/latest"]);
      expect(codes).toContain("NPM_CURRENT");
      expect(codes).not.toContain("UNPINNED_PACKAGE");
      expect(codes).not.toContain("NPM_DRIFT");
      expect(codes).not.toContain("NPM_LOOKUP_FAILED");
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
