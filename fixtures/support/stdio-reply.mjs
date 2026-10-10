import readline from "node:readline";

/** Answer an initialize request on stdin. Ignores anything else. */
export function replyToInitialize() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg?.method !== "initialize") return;
    const response = {
      jsonrpc: "2.0",
      id: msg.id ?? 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        serverInfo: { name: "fixture-probe-server", version: "0.0.1" },
      },
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}
