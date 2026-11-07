import { RuntimeInputError } from "../terminalRuntime";
import type { ApiRouteHandler, TerminalRuntime } from "./routeHelpers";
import { readJsonBodyOrWriteError, writeJson, writeMethodNotAllowed } from "./routeHelpers";

type ProviderEventRuntime = TerminalRuntime & {
  logProviderEventReject?: (details: {
    terminalId: string;
    status: number;
    reason: string;
    tokenPresent: boolean;
    token?: string;
    payload: unknown;
  }) => void;
  recordCodexProviderEvent?: (details: { terminalId: string; token: string; payload: unknown }) => unknown;
};

const CODEX_PROVIDER_EVENT_PATH = "/api/provider-events/codex";

export const handleCodexProviderEventRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { runtime: terminalRuntime },
) => {
  const runtime = terminalRuntime as ProviderEventRuntime;
  if (requestUrl.pathname !== CODEX_PROVIDER_EVENT_PATH) return false;
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const header = request.headers["x-octogent-session"];
  const terminalId = typeof header === "string" ? header.trim() : "";
  const tokenHeader = request.headers["x-octogent-provider-token"];
  const providerEventToken = typeof tokenHeader === "string" ? tokenHeader.trim() : "";
  if (!terminalId) {
    runtime.logProviderEventReject?.({
      terminalId: "",
      status: 400,
      reason: "X-Octogent-Session is required.",
      tokenPresent: false,
      payload: null,
    });
    writeJson(response, 400, { error: "X-Octogent-Session is required." }, corsOrigin);
    return true;
  }

  const bodyReadResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyReadResult.ok) return true;
  const body = (bodyReadResult.payload ?? {}) as { payload?: unknown } & Record<string, unknown>;
  const payload = body.payload ?? body;

  try {
    runtime.recordCodexProviderEvent?.({ terminalId, token: providerEventToken, payload });
    writeJson(response, 202, { accepted: true }, corsOrigin);
  } catch (error) {
    if (error instanceof RuntimeInputError) {
      runtime.logProviderEventReject?.({
        terminalId,
        status: 409,
        reason: error.message,
        tokenPresent: providerEventToken.length > 0,
        token: providerEventToken,
        payload,
      });
      writeJson(response, 409, { error: error.message }, corsOrigin);
      return true;
    }
    throw error;
  }
  return true;
};
