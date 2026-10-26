import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { Finding, HealthReport, Severity } from "./types.js";
import { VERSION } from "./version.js";

const SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

function levelFor(severity: Severity): "error" | "warning" | "note" {
  if (severity === "fail") return "error";
  if (severity === "warn") return "warning";
  return "note";
}

function reportFindings(report: HealthReport): Finding[] {
  return report.servers.flatMap((server) =>
    server.findings.filter((finding) => finding.severity !== "ok"),
  );
}

/**
 * Directory SARIF and annotation paths are relative to.
 * A scan root inside the workspace (process cwd, or a monorepo package under
 * it) uses the workspace, so `path: services/api` still points at
 * `services/api/.vscode/mcp.json`. A scan root outside the workspace stays
 * its own root.
 */
export function annotationRoot(scanRoot: string, cwd = process.cwd()): string {
  const rel = relative(cwd, scanRoot);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return cwd;
  return scanRoot;
}

export function artifactUri(root: string, file: string | undefined): string {
  if (!file) return "mcp-health";
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return file.replace(/\\/g, "/");
  }
  return rel.replace(/\\/g, "/");
}

export function lineOfServer(file: string | undefined, server?: string): number {
  if (!file || !server || !existsSync(file)) return 1;
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const quoted = `"${server}"`;
    const table = `[mcp_servers.${server}]`;
    const index = lines.findIndex(
      (line) => line.includes(quoted) || line.includes(table),
    );
    return index === -1 ? 1 : index + 1;
  } catch {
    return 1;
  }
}

function findingText(finding: Finding): string {
  const text = finding.server
    ? `${finding.server}: ${finding.message}`
    : finding.message;
  const hint = finding.hint?.trim();
  return hint ? `${text}\n${hint}` : text;
}

export function buildSarif(report: HealthReport): Record<string, unknown> {
  const findings = reportFindings(report);
  const base = annotationRoot(report.root);
  const rules = new Map<string, "error" | "warning" | "note">();
  for (const finding of findings) {
    const level = levelFor(finding.severity);
    const existing = rules.get(finding.code);
    if (!existing || (existing !== "error" && level === "error")) {
      rules.set(finding.code, level);
    }
  }

  return {
    $schema: SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "mcp-health",
            version: VERSION,
            informationUri: "https://github.com/leon-pixel/mcp-health",
            rules: [...rules.entries()].map(([id, level]) => ({
              id,
              shortDescription: { text: id },
              defaultConfiguration: { level },
            })),
          },
        },
        results: findings.map((finding) => {
          const file = finding.file;
          const uri = artifactUri(base, file);
          return {
            ruleId: finding.code,
            level: levelFor(finding.severity),
            message: {
              text: findingText(finding),
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri },
                  region: { startLine: lineOfServer(file, finding.server) },
                },
              },
            ],
          };
        }),
      },
    ],
  };
}

function escapeWorkflowData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeWorkflowProperty(text: string): string {
  return escapeWorkflowData(text).replace(/,/g, "%2C").replace(/:/g, "%3A");
}

/** GitHub Actions workflow commands. One line per warn/fail finding. */
export function formatAnnotations(report: HealthReport): string {
  const lines: string[] = [];
  const base = annotationRoot(report.root);
  for (const finding of reportFindings(report)) {
    const command = finding.severity === "fail" ? "error" : "warning";
    const file = artifactUri(base, finding.file);
    const line = lineOfServer(finding.file, finding.server);
    const title = escapeWorkflowProperty(finding.code);
    const message = escapeWorkflowData(findingText(finding));
    lines.push(
      `::${command} file=${escapeWorkflowProperty(file)},line=${line},title=${title}::${message}`,
    );
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}
