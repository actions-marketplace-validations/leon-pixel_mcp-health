import type { Finding, HealthReport, ServerReport } from "./types.js";

const icons = { ok: "OK", warn: "WARN", fail: "FAIL" } as const;

/** Config-file warnings that are not server rows and not a missing-file NO_CONFIG. */
export function configWarningFindings(servers: ServerReport[]): Finding[] {
  return servers.flatMap((server) => {
    if (!server.name.startsWith("(")) return [];
    return server.findings.filter(
      (finding) => finding.severity === "warn" && finding.code !== "NO_CONFIG",
    );
  });
}

function summaryLine(report: HealthReport): string {
  const summary = report.summary;
  const counts = `files: ${summary.files}  servers: ${summary.servers}  ok: ${summary.ok}  warn: ${summary.warn}  fail: ${summary.fail}  skipped: ${summary.skipped}`;
  const warnings = configWarningFindings(report.servers);
  if (warnings.length === 0) return counts;
  const codes = [...new Set(warnings.map((finding) => finding.code))].join(", ");
  if (exitCode(report) === 1 && summary.warn === 0 && summary.fail === 0) {
    return `${counts}  exit 1 because of a config-level warning (${codes})`;
  }
  return `${counts}  config-level warning (${codes})`;
}

export function formatHuman(report: HealthReport): string {
  const lines: string[] = [];
  lines.push(`mcp-health — scanned ${report.root}`);
  lines.push(summaryLine(report));
  lines.push("");

  if (report.files.length) {
    lines.push("Configs:");
    for (const f of report.files) lines.push(`  - ${f}`);
    lines.push("");
  }

  for (const server of report.servers) {
    lines.push(
      `[${icons[server.status]}] ${server.name}  (${server.transport})  ${server.file}`,
    );
    for (const finding of server.findings) {
      lines.push(
        `    - ${icons[finding.severity]} ${finding.code}: ${finding.message}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function formatJson(report: HealthReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function exitCode(report: HealthReport): number {
  let fail = false;
  let warn = false;
  for (const server of report.servers) {
    if (server.status === "fail") fail = true;
    else if (server.status === "warn") warn = true;
  }
  if (fail) return 2;
  if (warn) return 1;
  return 0;
}
