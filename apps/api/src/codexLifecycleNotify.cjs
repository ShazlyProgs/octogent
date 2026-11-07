"use strict";

// P36: record failed / non-2xx posts locally (never the token or message bodies); short timeout, never throws.
const recordFailure = (terminalId, status, error) => {
  try {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const dir = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), ".octogent");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "codex-notify-failures.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        terminalId: terminalId || null,
        status: status ?? null,
        error: error ? String(error).slice(0, 200) : null,
      }) + "\n",
    );
  } catch {}
};

const main = async () => {
  const terminalId = process.env.OCTOGENT_SESSION_ID?.trim();
  const apiOrigin = process.env.OCTOGENT_API_ORIGIN?.trim();
  const token = process.env.OCTOGENT_PROVIDER_EVENT_TOKEN?.trim();
  let payload = {};
  try {
    payload = JSON.parse(process.argv[3] ?? "{}");
  } catch {
    payload = {};
  }
  const messages = Array.isArray(payload["input-messages"]) ? payload["input-messages"] : [];
  const correlation = { processGeneration: Number(process.argv[2] ?? 0), turnId: null };
  for (const message of messages) {
    const match = /<octogent-turn\s+process-generation="([^"]+)"\s+id="([^"]+)"\s*\/>/.exec(String(message));
    if (match) {
      correlation.processGeneration = Number(match[1]);
      correlation.turnId = match[2];
    }
  }
  payload["octogent-process-generation"] = correlation.processGeneration;
  payload["octogent-turn-id"] = correlation.turnId;
  if (!apiOrigin) {
    recordFailure(terminalId, null, "missing OCTOGENT_API_ORIGIN");
    return;
  }
  try {
    const res = await fetch(`${apiOrigin}/api/provider-events/codex`, {
      ...(typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? { signal: AbortSignal.timeout(3000) }
        : {}),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(terminalId ? { "X-Octogent-Session": terminalId } : {}),
        ...(token ? { "X-Octogent-Provider-Token": token } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) recordFailure(terminalId, res.status, null);
  } catch (error) {
    recordFailure(terminalId, null, error && error.name ? `${error.name}: ${error.message}` : error);
    // Notifications are best-effort and must never wedge the Codex TUI.
  }
};

main();
