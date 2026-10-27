import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exitCode, formatHuman, formatJson } from "./report.js";
import { runCheck } from "./run.js";
import { buildSarif, formatAnnotations } from "./sarif.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "..", "fixtures");

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  extra: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": contentType, ...extra });
  res.end(body);
}

describe("stdio probe", () => {
  it("expands ${workspaceFolder} and ${env:…} before launching", async () => {
    process.env.MCP_HEALTH_MARK_SRC = "ok";
    try {
      const report = await runCheck({
        root: join(fixtures, "vscode-vars"),
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 4000,
      });
      expect(report.summary.fail).toBe(0);
      expect(report.summary.warn).toBe(0);
      const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
      expect(codes).toContain("PROBE_OK");
      expect(codes).toContain("TOOLS_OK");
    } finally {
      delete process.env.MCP_HEALTH_MARK_SRC;
    }
  });

  it("runs relative args from the project root, not the config directory", async () => {
    const report = await runCheck({
      root: join(fixtures, "probe-cwd"),
      includeUserConfig: false,
      probe: true,
      probeTimeoutMs: 4000,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(codes).toContain("PROBE_OK");
    expect(codes).toContain("TOOLS_OK");
  });

  it("fails as soon as the server process exits", async () => {
    const started = Date.now();
    const report = await runCheck({
      root: join(fixtures, "probe-exit"),
      includeUserConfig: false,
      probe: true,
      probeTimeoutMs: 4000,
    });
    expect(Date.now() - started).toBeLessThan(2500);
    const failed = report.servers
      .flatMap((s) => s.findings)
      .find((f) => f.code === "PROBE_FAILED");
    expect(failed?.message).toMatch(/code 7/);
    expect(failed?.message).toMatch(/exited-immediately/);
    const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(codes).not.toContain("HEALTHY");
  });

  it("skips logs, notifications, and responses with a different id", async () => {
    const report = await runCheck({
      root: join(fixtures, "probe-noisy"),
      includeUserConfig: false,
      probe: true,
      probeTimeoutMs: 4000,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    const codes = report.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(codes).toContain("PROBE_OK");
    expect(codes).toContain("TOOLS_OK");
    expect(codes).not.toContain("PROBE_INIT_ERROR");
    expect(codes).not.toContain("PROBE_FAILED");
  });

  it("falls back to server/discover when initialize is an unknown method", async () => {
    const report = await runCheck({
      root: join(fixtures, "probe-modern"),
      includeUserConfig: false,
      probe: true,
      probeTimeoutMs: 4000,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    const findings = report.servers.flatMap((s) => s.findings);
    const ok = findings.find((f) => f.code === "PROBE_OK");
    expect(ok?.message).toMatch(/discover/);
    expect(findings.map((f) => f.code)).toContain("TOOLS_OK");
  });

  it("warns on an empty tool list and on tools/list errors, and stays quiet with --no-tools", async () => {
    const report = await runCheck({
      root: join(fixtures, "probe-tools"),
      includeUserConfig: false,
      probe: true,
      probeTimeoutMs: 4000,
    });
    const byName = new Map(report.servers.map((server) => [server.name, server]));
    const codes = (name: string) => byName.get(name)?.findings.map((f) => f.code) ?? [];

    expect(byName.get("with-tools")?.status).toBe("ok");
    expect(codes("with-tools")).toEqual(
      expect.arrayContaining(["PROBE_OK", "TOOLS_OK", "HEALTHY"]),
    );
    expect(codes("with-tools")).not.toContain("EMPTY_TOOLS");

    expect(byName.get("no-tools")?.status).toBe("warn");
    expect(codes("no-tools")).toContain("EMPTY_TOOLS");
    expect(codes("no-tools")).toContain("PROBE_OK");
    expect(codes("no-tools")).not.toContain("HEALTHY");

    expect(byName.get("tools-error")?.status).toBe("warn");
    expect(codes("tools-error")).toContain("TOOLS_LIST_FAILED");
    expect(codes("tools-error")).not.toContain("PROBE_FAILED");
    expect(byName.get("tools-error")?.status).not.toBe("fail");

    expect(JSON.stringify(report)).not.toContain("super-secret-tool-token");
    expect(report.summary.fail).toBe(0);

    const skipped = await runCheck({
      root: join(fixtures, "probe-tools"),
      includeUserConfig: false,
      probe: true,
      probeListTools: false,
      probeTimeoutMs: 4000,
    });
    const skippedCodes = skipped.servers.flatMap((s) => s.findings.map((f) => f.code));
    expect(skippedCodes).toContain("PROBE_OK");
    expect(skippedCodes).not.toContain("EMPTY_TOOLS");
    expect(skippedCodes).not.toContain("TOOLS_LIST_FAILED");
    expect(skippedCodes).not.toContain("TOOLS_OK");
    expect(skipped.summary.fail).toBe(0);
    expect(skipped.summary.warn).toBe(0);
    expect(skipped.servers.every((server) => server.status === "ok")).toBe(true);
  });
});

describe("http probe", () => {
  it("sends headers, reads SSE, treats 401 as a failure, and can discover", async () => {
    const seen: {
      url?: string;
      authorization?: string;
      protocol?: string;
      session?: string | string[];
      body: string;
    }[] = [];
    const server = createServer(async (req, res) => {
      const body = await readBody(req);
      seen.push({
        url: req.url,
        authorization: req.headers.authorization,
        protocol: req.headers["mcp-protocol-version"] as string | undefined,
        session: req.headers["mcp-session-id"],
        body,
      });
      const url = req.url ?? "/";

      if (url === "/deny") {
        send(res, 401, "", "text/plain");
        return;
      }
      if (url === "/missing") {
        send(res, 404, "missing", "text/plain");
        return;
      }
      if (url === "/mcp") {
        if (req.headers.authorization !== "Bearer s3cret") {
          send(res, 401, "unauthorized", "text/plain");
          return;
        }
        const payload = JSON.parse(body) as { id?: number; method?: string };
        if (payload.method === "tools/list") {
          send(
            res,
            200,
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id ?? 3,
              result: { tools: [{ name: "echo" }] },
            }),
            "application/json",
          );
          return;
        }
        const sse = [
          "event: message",
          "data: ",
          "",
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: { level: "info", data: "hi" },
          })}`,
          "",
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            error: { message: "wrong id" },
          })}`,
          "",
          `data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id ?? 1,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "sse", version: "0" },
            },
          })}`,
          "",
        ].join("\n");
        send(res, 200, sse, "text/event-stream");
        return;
      }
      if (url === "/modern") {
        const payload = JSON.parse(body) as { id?: number; method?: string };
        if (payload.method === "initialize") {
          send(
            res,
            400,
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id ?? 1,
              error: { code: -32601, message: "Method not found" },
            }),
            "application/json",
          );
          return;
        }
        if (payload.method === "server/discover") {
          send(
            res,
            200,
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id ?? 2,
              result: { supportedVersions: ["2026-07-28"], capabilities: {} },
            }),
            "application/json",
          );
          return;
        }
        if (payload.method === "tools/list") {
          send(
            res,
            200,
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id ?? 3,
              result: { tools: [{ name: "echo" }] },
            }),
            "application/json",
          );
          return;
        }
      }
      send(res, 500, "unhandled", "text/plain");
    });

    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a port");
    }
    const base = `http://127.0.0.1:${address.port}`;
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-http-"));
    process.env.MCP_HEALTH_HTTP_TOKEN = "s3cret";

    try {
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            "no-auth": { url: `${base}/deny` },
            authed: {
              url: `${base}/mcp`,
              headers: {
                Authorization: "Bearer ${env:MCP_HEALTH_HTTP_TOKEN}",
              },
            },
            missing: { url: `${base}/missing` },
            modern: { url: `${base}/modern` },
          },
        }),
      );

      const report = await runCheck({
        root: dir,
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 4000,
      });

      const byName = new Map(report.servers.map((serverReport) => [serverReport.name, serverReport]));
      const codes = (name: string) =>
        byName.get(name)?.findings.map((f) => f.code) ?? [];

      expect(codes("no-auth")).toContain("PROBE_HTTP_AUTH");
      expect(codes("no-auth")).not.toContain("PROBE_HTTP_REACHABLE");
      expect(codes("no-auth")).not.toContain("TOOLS_LIST_FAILED");
      expect(codes("no-auth")).not.toContain("HEALTHY");
      expect(byName.get("no-auth")?.status).toBe("fail");

      expect(codes("authed")).toContain("PROBE_OK");
      expect(codes("authed")).toContain("TOOLS_OK");
      expect(byName.get("authed")?.status).toBe("ok");

      expect(codes("missing")).toContain("PROBE_HTTP_REACHABLE");
      expect(codes("missing")).not.toContain("HEALTHY");
      expect(codes("missing")).not.toContain("TOOLS_OK");
      expect(byName.get("missing")?.status).toBe("warn");

      expect(codes("modern")).toContain("PROBE_OK");
      expect(codes("modern")).toContain("TOOLS_OK");
      expect(
        byName.get("modern")?.findings.find((f) => f.code === "PROBE_OK")?.message,
      ).toMatch(/discover/);

      const text = formatHuman(report);
      const missingBlock = text.split("[WARN] missing")[1]?.split("\n[")[0] ?? "";
      expect(missingBlock).toContain("PROBE_HTTP_REACHABLE");
      expect(missingBlock).not.toContain("HEALTHY");
      expect(JSON.stringify(report)).not.toContain("s3cret");

      const authed = seen.find((entry) => entry.url === "/mcp");
      expect(authed?.authorization).toBe("Bearer s3cret");
      expect(authed?.protocol).toBe("2025-11-25");
      expect(authed?.session).toBeUndefined();
      expect(JSON.parse(authed?.body ?? "{}").params.protocolVersion).toBe(
        "2025-11-25",
      );
      const mcpCalls = seen.filter((entry) => entry.url === "/mcp");
      expect(mcpCalls.map((entry) => JSON.parse(entry.body).method)).toEqual([
        "initialize",
        "tools/list",
      ]);
      expect(mcpCalls.every((entry) => entry.session === undefined)).toBe(true);
      const modernCalls = seen.filter((entry) => entry.url === "/modern");
      expect(modernCalls.map((entry) => JSON.parse(entry.body).method)).toEqual([
        "initialize",
        "server/discover",
        "tools/list",
      ]);
      expect(modernCalls[1]?.protocol).toBe("2026-07-28");
      expect(modernCalls[2]?.protocol).toBe("2026-07-28");
      expect(modernCalls.every((entry) => entry.session === undefined)).toBe(true);
      expect(seen.filter((entry) => entry.url === "/deny")).toHaveLength(1);
    } finally {
      delete process.env.MCP_HEALTH_HTTP_TOKEN;
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("warns on an OAuth challenge and fails a plain 401", async () => {
    const server = createServer(async (req, res) => {
      await readBody(req);
      if (req.url === "/oauth") {
        res.writeHead(401, {
          "www-authenticate":
            'Bearer realm="OAuth", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
        });
        res.end();
        return;
      }
      res.writeHead(401);
      res.end();
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-oauth-"));
    try {
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            linearish: { url: `${base}/oauth` },
            locked: { url: `${base}/plain` },
          },
        }),
      );
      const report = await runCheck({
        root: dir,
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 4000,
      });
      const byName = new Map(report.servers.map((serverReport) => [serverReport.name, serverReport]));
      expect(byName.get("linearish")?.status).toBe("warn");
      expect(byName.get("linearish")?.findings.map((f) => f.code)).toContain("PROBE_OAUTH");
      expect(byName.get("linearish")?.findings.map((f) => f.code)).not.toContain(
        "PROBE_HTTP_AUTH",
      );
      expect(byName.get("locked")?.status).toBe("fail");
      expect(byName.get("locked")?.findings.map((f) => f.code)).toContain("PROBE_HTTP_AUTH");
      expect(exitCode(report)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("sends Codex bearer and env headers without logging the secret", async () => {
    const seen: { authorization?: string; extra?: string }[] = [];
    const server = createServer(async (req, res) => {
      const body = await readBody(req);
      seen.push({
        authorization: req.headers.authorization,
        extra: req.headers["x-test"] as string | undefined,
      });
      const payload = JSON.parse(body) as { id?: number; method?: string };
      const result =
        payload.method === "tools/list"
          ? { tools: [{ name: "echo" }] }
          : {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "auth", version: "0" },
            };
      send(
        res,
        200,
        JSON.stringify({ jsonrpc: "2.0", id: payload.id ?? 1, result }),
        "application/json",
      );
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-bearer-"));
    process.env.MCP_HEALTH_BEARER = "super-secret-bearer-token";
    process.env.MCP_HEALTH_HEADER = "super-secret-header-token";
    try {
      writeFileSync(
        join(dir, "config.toml"),
        [
          "[mcp_servers.remote]",
          `url = "http://127.0.0.1:${address.port}/mcp"`,
          'bearer_token_env_var = "MCP_HEALTH_BEARER"',
          "",
          "[mcp_servers.remote.env_http_headers]",
          'X-Test = "MCP_HEALTH_HEADER"',
          "",
        ].join("\n"),
      );
      const report = await runCheck({
        root: dir,
        files: [join(dir, "config.toml")],
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 4000,
      });
      expect(seen.some((entry) => entry.authorization === "Bearer super-secret-bearer-token")).toBe(
        true,
      );
      expect(seen.some((entry) => entry.extra === "super-secret-header-token")).toBe(true);
      expect(report.servers[0]?.status).toBe("ok");
      const dumped = JSON.stringify(report);
      expect(dumped).not.toContain("super-secret-bearer-token");
      expect(dumped).not.toContain("super-secret-header-token");

      delete process.env.MCP_HEALTH_BEARER;
      delete process.env.MCP_HEALTH_HEADER;
      const missing = await runCheck({
        root: dir,
        files: [join(dir, "config.toml")],
        includeUserConfig: false,
      });
      const codes = missing.servers.flatMap((serverReport) =>
        serverReport.findings.map((f) => f.code),
      );
      expect(codes).toContain("AUTH_ENV_UNSET");
      expect(missing.servers.flatMap((s) => s.findings.map((f) => f.message)).join("\n")).toContain(
        "MCP_HEALTH_BEARER",
      );
      expect(JSON.stringify(missing)).not.toContain("super-secret");
    } finally {
      delete process.env.MCP_HEALTH_BEARER;
      delete process.env.MCP_HEALTH_HEADER;
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("includes ECONNREFUSED when the HTTP server is down", async () => {
    const server = createServer((_req, res) => {
      res.end();
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const port = address.port;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-refused-"));
    try {
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({ mcpServers: { down: { url: `http://127.0.0.1:${port}/mcp` } } }),
      );
      const report = await runCheck({
        root: dir,
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 4000,
      });
      const failed = report.servers.flatMap((s) => s.findings).find((f) => f.code === "PROBE_FAILED");
      expect(failed?.message).toMatch(/ECONNREFUSED/);
      expect(exitCode(report)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends Mcp-Session-Id on later requests and does not print it", async () => {
    const legacySession = "sess-legacy-do-not-print";
    const initSession = "sess-init-do-not-print";
    const discoverSession = "sess-discover-do-not-print";
    const freshSession = "sess-fresh-do-not-print";
    const secrets = [legacySession, initSession, discoverSession, freshSession];

    const seen: {
      url?: string;
      method?: string;
      session?: string | string[];
      protocol?: string | string[];
    }[] = [];

    const server = createServer(async (req, res) => {
      const body = await readBody(req);
      const url = req.url ?? "/";
      let payload: { id?: number; method?: string } = {};
      try {
        payload = JSON.parse(body) as { id?: number; method?: string };
      } catch {
        payload = {};
      }
      seen.push({
        url,
        method: payload.method,
        session: req.headers["mcp-session-id"],
        protocol: req.headers["mcp-protocol-version"],
      });

      if (payload.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }

      const tools = JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id ?? 3,
        result: { tools: [{ name: "echo" }] },
      });
      const initialized = JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id ?? 1,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "session", version: "0" },
        },
      });
      const rejectSession = () => {
        send(
          res,
          400,
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id ?? 3,
            error: { code: -32600, message: "session required" },
          }),
          "application/json",
        );
      };

      if (url === "/session" || url === "/sse" || url === "/fresh") {
        const expected = url === "/fresh" ? freshSession : legacySession;
        if (payload.method === "tools/list") {
          if (req.headers["mcp-session-id"] !== expected) {
            rejectSession();
            return;
          }
          send(res, 200, tools, "application/json");
          return;
        }
        if (url === "/sse") {
          send(res, 200, `data: ${initialized}\n\n`, "text/event-stream", {
            "Mcp-Session-Id": legacySession,
          });
          return;
        }
        send(res, 200, initialized, "application/json", { "Mcp-Session-Id": expected });
        return;
      }

      if (url === "/discover") {
        if (payload.method === "initialize") {
          send(
            res,
            400,
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id ?? 1,
              error: { code: -32601, message: "Method not found" },
            }),
            "application/json",
            { "Mcp-Session-Id": initSession },
          );
          return;
        }
        if (payload.method === "server/discover") {
          send(
            res,
            200,
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id ?? 2,
              result: { supportedVersions: ["2026-07-28"], capabilities: {} },
            }),
            "application/json",
            { "Mcp-Session-Id": discoverSession },
          );
          return;
        }
        if (payload.method === "tools/list") {
          if (req.headers["mcp-session-id"] !== discoverSession) {
            rejectSession();
            return;
          }
          send(res, 200, tools, "application/json");
          return;
        }
      }

      if (url === "/plain" || url === "/keep" || url === "/blank") {
        if (payload.method === "tools/list") {
          if (url !== "/keep" && req.headers["mcp-session-id"] !== undefined) {
            rejectSession();
            return;
          }
          send(res, 200, tools, "application/json");
          return;
        }
        send(
          res,
          200,
          initialized,
          "application/json",
          url === "/blank" ? { "Mcp-Session-Id": "   " } : {},
        );
        return;
      }

      if (url === "/boom") {
        send(
          res,
          200,
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id ?? 1,
            error: { code: -32603, message: "initialize failed" },
          }),
          "application/json",
          { "Mcp-Session-Id": legacySession },
        );
        return;
      }

      if (url === "/down") {
        send(res, 500, "nope", "text/plain", { "Mcp-Session-Id": legacySession });
        return;
      }

      send(res, 500, "unhandled", "text/plain");
    });

    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const dir = mkdtempSync(join(tmpdir(), "mcp-health-session-"));
    const file = join(dir, "mcp.json");
    const original = JSON.stringify({
      mcpServers: {
        session: { url: `${base}/session` },
        sse: { url: `${base}/sse` },
        fresh: {
          url: `${base}/fresh`,
          headers: { "Mcp-Session-Id": "stale-config-session" },
        },
        discover: { url: `${base}/discover` },
        plain: { url: `${base}/plain` },
        keep: {
          url: `${base}/keep`,
          headers: { "Mcp-Session-Id": "stale-config-session" },
        },
        blank: { url: `${base}/blank` },
        boom: { url: `${base}/boom` },
        down: { url: `${base}/down` },
      },
    });
    writeFileSync(file, original);

    const calls = (path: string) => seen.filter((entry) => entry.url === path);
    const methods = (path: string) => calls(path).map((entry) => entry.method);
    const rendered = (report: Awaited<ReturnType<typeof runCheck>>) =>
      [
        formatHuman(report),
        formatJson(report),
        JSON.stringify(buildSarif(report)),
        formatAnnotations(report),
      ].join("\n");

    try {
      const report = await runCheck({
        root: dir,
        includeUserConfig: false,
        probe: true,
        probeTimeoutMs: 4000,
      });
      const byName = new Map(report.servers.map((serverReport) => [serverReport.name, serverReport]));
      const codes = (name: string) => byName.get(name)?.findings.map((finding) => finding.code) ?? [];

      expect(methods("/session")).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(calls("/session")[0]?.session).toBeUndefined();
      expect(calls("/session")[1]?.session).toBe(legacySession);
      expect(calls("/session")[2]?.session).toBe(legacySession);
      expect(calls("/session")[1]?.protocol).toBe("2025-11-25");
      expect(calls("/session")[2]?.protocol).toBe("2025-11-25");

      expect(methods("/sse")).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(calls("/sse")[0]?.session).toBeUndefined();
      expect(calls("/sse")[1]?.session).toBe(legacySession);
      expect(calls("/sse")[2]?.session).toBe(legacySession);

      expect(methods("/fresh")).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(calls("/fresh")[0]?.session).toBe("stale-config-session");
      expect(calls("/fresh")[1]?.session).toBe(freshSession);
      expect(calls("/fresh")[2]?.session).toBe(freshSession);

      expect(methods("/discover")).toEqual(["initialize", "server/discover", "tools/list"]);
      expect(calls("/discover")[0]?.session).toBeUndefined();
      expect(calls("/discover")[1]?.session).toBe(initSession);
      expect(calls("/discover")[2]?.session).toBe(discoverSession);
      expect(calls("/discover")[1]?.protocol).toBe("2026-07-28");
      expect(calls("/discover")[2]?.protocol).toBe("2026-07-28");

      expect(methods("/plain")).toEqual(["initialize", "tools/list"]);
      expect(calls("/plain").every((entry) => entry.session === undefined)).toBe(true);
      expect(methods("/blank")).toEqual(["initialize", "tools/list"]);
      expect(calls("/blank").every((entry) => entry.session === undefined)).toBe(true);
      expect(methods("/keep")).toEqual(["initialize", "tools/list"]);
      expect(calls("/keep").every((entry) => entry.session === "stale-config-session")).toBe(true);

      expect(methods("/boom")).toEqual(["initialize"]);
      expect(methods("/down")).toEqual(["initialize"]);

      for (const name of ["session", "sse", "fresh", "discover", "plain", "keep", "blank"]) {
        expect(byName.get(name)?.status, name).toBe("ok");
        expect(codes(name), name).toContain("PROBE_OK");
        expect(codes(name), name).toContain("TOOLS_OK");
        expect(codes(name), name).not.toContain("TOOLS_LIST_FAILED");
        expect(
          byName.get(name)?.findings.every((finding) => finding.severity === "ok"),
          name,
        ).toBe(true);
      }
      expect(
        byName.get("discover")?.findings.find((finding) => finding.code === "PROBE_OK")?.message,
      ).toMatch(/discover/);
      expect(byName.get("boom")?.status).toBe("fail");
      expect(codes("boom")).toContain("PROBE_INIT_ERROR");
      expect(codes("boom")).not.toContain("TOOLS_OK");
      expect(codes("boom")).not.toContain("TOOLS_LIST_FAILED");
      expect(byName.get("down")?.status).toBe("fail");
      expect(codes("down")).toContain("PROBE_HTTP_ERROR");
      expect(codes("down")).not.toContain("TOOLS_LIST_FAILED");

      const text = rendered(report);
      for (const secret of secrets) expect(text).not.toContain(secret);
      expect(text).not.toContain("stale-config-session");
      expect(readFileSync(file, "utf8")).toBe(original);

      seen.length = 0;
      const skipped = await runCheck({
        root: dir,
        includeUserConfig: false,
        probe: true,
        probeListTools: false,
        probeTimeoutMs: 4000,
      });
      expect(methods("/session")).toEqual(["initialize", "notifications/initialized"]);
      expect(calls("/session")[1]?.session).toBe(legacySession);
      expect(methods("/plain")).toEqual(["initialize"]);
      expect(methods("/discover")).toEqual(["initialize", "server/discover"]);
      const skippedSession = skipped.servers.find((entry) => entry.name === "session");
      expect(skippedSession?.status).toBe("ok");
      expect(skippedSession?.findings.map((finding) => finding.code)).toContain("PROBE_OK");
      expect(skippedSession?.findings.map((finding) => finding.code)).not.toContain("TOOLS_OK");
      expect(skippedSession?.findings.map((finding) => finding.code)).not.toContain(
        "TOOLS_LIST_FAILED",
      );
      const skippedText = rendered(skipped);
      for (const secret of secrets) expect(skippedText).not.toContain(secret);
      expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
