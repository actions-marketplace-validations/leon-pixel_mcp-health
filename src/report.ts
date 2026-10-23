import type { Finding, HealthReport, ServerReport } from "./types.js";

const icons = { ok: "OK", warn: "WARN", fail: "FAIL" } as const;

function configLevelFindings(
  servers: ServerReport[],
  severity: "warn" | "fail",
): Finding[] {
  return servers.flatMap((server) => {
    if (!server.name.startsWith("(")) return [];
    return server.findings.filter((finding) => {
      if (finding.severity !== severity) return false;
      // NO_CONFIG is the whole scan, and its message already explains the exit.
      if (severity === "warn" && finding.code === "NO_CONFIG") return false;
      return true;
    });
  });
}

/** Config-file warnings that are not server rows and not a missing-file NO_CONFIG. */
export function configWarningFindings(servers: ServerReport[]): Finding[] {
  return configLevelFindings(servers, "warn");
}

function findingCodes(findings: Finding[]): string {
  return [...new Set(findings.map((finding) => finding.code))].join(", ");
}

function summaryLine(report: HealthReport): string {
  const summary = report.summary;
  const counts = `files: ${summary.files}  servers: ${summary.servers}  ok: ${summary.ok}  warn: ${summary.warn}  fail: ${summary.fail}  skipped: ${summary.skipped}`;
  const warnings = configWarningFindings(report.servers);
  const failures = configLevelFindings(report.servers, "fail");
  const notes: string[] = [];
  if (failures.length > 0) {
    const codes = findingCodes(failures);
    notes.push(
      exitCode(report) === 2 && summary.fail === 0
        ? `exit 2 because of a config-level failure (${codes})`
        : `config-level failure (${codes})`,
    );
  }
  if (warnings.length > 0) {
    const codes = findingCodes(warnings);
    notes.push(
      exitCode(report) === 1 && summary.warn === 0 && summary.fail === 0
        ? `exit 1 because of a config-level warning (${codes})`
        : `config-level warning (${codes})`,
    );
  }
  if (notes.length === 0) return counts;
  return `${counts}  ${notes.join("  ")}`;
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
    const origin =
      server.scope === "project" || server.scope === "user"
        ? `${server.scope}  `
        : "";
    lines.push(
      `[${icons[server.status]}] ${server.name}  (${server.transport})  ${origin}${server.file}`,
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
