import { join } from "node:path";

import type { FleetVerdictProduction, FleetVerifyArtifact, FleetVerifyContext } from "./fleetSpawn";

type FetchLike = typeof globalThis.fetch;

type ConversationTurnPayload = {
  role?: unknown;
  content?: unknown;
};

const readJson = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json().catch(() => ({}))) as Record<string, unknown>;

const errorMessage = (payload: Record<string, unknown>, fallback: string): string =>
  typeof payload.error === "string" && payload.error.trim().length > 0 ? payload.error : fallback;

const defaultWait = (milliseconds: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

export class FleetVerdictProducerError extends Error {
  readonly tracePointer: string | null;
  readonly verifierTerminalId: string | null;

  constructor(
    message: string,
    options: { tracePointer?: string | null; verifierTerminalId?: string | null } = {},
  ) {
    super(message);
    this.name = "FleetVerdictProducerError";
    this.tracePointer = options.tracePointer ?? null;
    this.verifierTerminalId = options.verifierTerminalId ?? null;
  }
}

/**
 * Build the production D4 verdict adapter over Octogent's own terminal runtime. The verifier is a
 * separate Claude Code terminal so the Stop hook writes structured turns, while the append-only
 * JSONL terminal transcript remains the full, unsummarized audit trace.
 */
export const createFleetVerdictProducer = (options: {
  apiBase: string;
  stateDir: string;
  parentTerminalId?: string;
  fetch?: FetchLike;
  wait?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}) => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const wait = options.wait ?? defaultWait;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;

  return async (prompt: string, context?: FleetVerifyContext): Promise<FleetVerdictProduction> => {
    const parentTerminalId = options.parentTerminalId ?? context?.parentTerminalId;
    if (!parentTerminalId) {
      throw new FleetVerdictProducerError("No fleet parent terminal is available for the verifier");
    }

    const createResponse = await fetchImpl(`${options.apiBase}/api/terminals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Fleet adversarial verifier",
        workspaceMode: "shared",
        agentProvider: "claude-code",
        parentTerminalId,
        initialPrompt: prompt,
        metadata: {
          fleetId: context?.fleetId ?? "fleet",
          fleetRoleState: "ephemeral-verifier",
          workProduct: "fleet-spawn",
        },
      }),
    });
    const createPayload = await readJson(createResponse);
    if (!createResponse.ok) {
      throw new FleetVerdictProducerError(
        `Unable to start adversarial verifier: ${errorMessage(createPayload, `HTTP ${createResponse.status}`)}`,
      );
    }

    const verifierTerminalId = String(createPayload.terminalId ?? "").trim();
    if (!verifierTerminalId) {
      throw new FleetVerdictProducerError("Adversarial verifier did not return a terminal id");
    }
    const tracePointer = join(
      options.stateDir,
      "state",
      "transcripts",
      `${encodeURIComponent(verifierTerminalId)}.jsonl`,
    );
    const terminalUrl = `${options.apiBase}/api/terminals/${encodeURIComponent(verifierTerminalId)}`;
    const startedAt = Date.now();

    try {
      while (Date.now() - startedAt < timeoutMs) {
        let conversationResponse: Response;
        try {
          conversationResponse = await fetchImpl(
            `${options.apiBase}/api/conversations/${encodeURIComponent(verifierTerminalId)}`,
          );
        } catch (error) {
          throw new FleetVerdictProducerError(
            `Unable to read verifier trace: ${error instanceof Error ? error.message : String(error)}`,
            { tracePointer, verifierTerminalId },
          );
        }
        const conversationPayload = await readJson(conversationResponse);
        if (conversationResponse.ok) {
          const turns = Array.isArray(conversationPayload.turns)
            ? (conversationPayload.turns as ConversationTurnPayload[])
            : [];
          const assistantTurn = [...turns]
            .reverse()
            .find(
              (turn) =>
                turn.role === "assistant" &&
                typeof turn.content === "string" &&
                turn.content.trim().length > 0,
            );
          if (assistantTurn && typeof assistantTurn.content === "string") {
            return {
              rawVerdict: assistantTurn.content.trim(),
              tracePointer,
              verifierTerminalId,
            };
          }
        } else if (conversationResponse.status !== 404) {
          throw new FleetVerdictProducerError(
            `Unable to read verifier trace: ${errorMessage(conversationPayload, `HTTP ${conversationResponse.status}`)}`,
            { tracePointer, verifierTerminalId },
          );
        }

        await wait(pollIntervalMs);
      }

      throw new FleetVerdictProducerError(
        `Adversarial verifier timed out after ${timeoutMs}ms without a verdict`,
        { tracePointer, verifierTerminalId },
      );
    } finally {
      // Removing the ephemeral terminal releases the parent's child slot. Terminal deletion closes
      // the session but deliberately leaves its append-only transcript in place for the trace link.
      try {
        await fetchImpl(terminalUrl, { method: "DELETE" });
      } catch {
        // Cleanup is best-effort; verdict persistence and the full trace take precedence.
      }
    }
  };
};

/** Surface a persisted verdict to the owning officer/root via the native channel. */
export const surfaceFleetVerifyArtifact = async (options: {
  apiBase: string;
  parentTerminalId: string;
  artifact: FleetVerifyArtifact;
  fetch?: FetchLike;
}): Promise<void> => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const { artifact } = options;
  const verdictLabel = artifact.verdict?.verdict ?? "PRODUCER_ERROR";
  const mustFix = artifact.verdict?.mustFix.length
    ? ` Must fix: ${artifact.verdict.mustFix.join("; ")}.`
    : "";
  const producerError = artifact.error ? ` Error: ${artifact.error}.` : "";
  const trace = artifact.tracePointer ?? "unavailable";
  const content = `[VERIFY ${artifact.outcome.toUpperCase()}] fleet "${artifact.fleetId}" standing spawn: ${verdictLabel}.${mustFix}${producerError} Full trace: ${trace}`;

  const response = await fetchImpl(
    `${options.apiBase}/api/channels/${encodeURIComponent(options.parentTerminalId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromTerminalId: artifact.verifierTerminalId ?? "fleet-verify-harness",
        content,
      }),
    },
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `Unable to surface adversarial-verify verdict to parent: ${errorMessage(payload, `HTTP ${response.status}`)}`,
    );
  }
};
