/**
 * Back-office HTTP client (#45 W-ORCH-NATIVE Phase 2 — the "tools" seam adapter).
 *
 * Executes a validated back-office request PLAN (from @octogent/core
 * buildBackOfficeRequest) against the live :3001 back-office services layer. This is
 * the ports-and-adapters boundary: the pure registry decides WHAT to call; this module
 * owns the infrastructure — base URL, X-API-Key auth (matches the :3001
 * machine-to-machine header), and fetch.
 *
 * The fleet NEVER modifies :3001 — it only calls the existing back-office routes. Config
 * comes from env so no secret is committed; the API key is read but never logged.
 */

import { type BackOfficeRequestPlan, buildBackOfficeRequest } from "@octogent/core";

export type BackOfficeClientConfig = {
  /** Base URL of the :3001 back-office server, e.g. "http://127.0.0.1:3001". No trailing slash. */
  baseUrl: string;
  /** Service-account API key sent as the X-API-Key header. */
  apiKey: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export type BackOfficeToolResult = {
  ok: boolean;
  status: number;
  toolName: string;
  mutates: boolean;
  /** Parsed JSON payload, or raw text when the response was not JSON. */
  data: unknown;
};

export class BackOfficeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackOfficeConfigError";
  }
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, "");

/**
 * Resolve client config from environment. Throws BackOfficeConfigError (fail-closed,
 * never falls back to an unauthenticated call) when either var is unset.
 *   COLLEGA_BACKOFFICE_BASE_URL  — e.g. http://127.0.0.1:3001 (or the Box B tunnel URL)
 *   COLLEGA_BACKOFFICE_API_KEY   — a :3001 service-account API key
 */
export const resolveBackOfficeConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): { baseUrl: string; apiKey: string } => {
  const baseUrl = env.COLLEGA_BACKOFFICE_BASE_URL?.trim();
  const apiKey = env.COLLEGA_BACKOFFICE_API_KEY?.trim();
  const missing: string[] = [];
  if (!baseUrl) missing.push("COLLEGA_BACKOFFICE_BASE_URL");
  if (!apiKey) missing.push("COLLEGA_BACKOFFICE_API_KEY");
  if (missing.length > 0) {
    throw new BackOfficeConfigError(
      `Back-office tools unavailable — set ${missing.join(" and ")} (see fleet/BACKOFFICE-TOOLS.md).`,
    );
  }
  return { baseUrl: stripTrailingSlash(baseUrl as string), apiKey: apiKey as string };
};

/** Execute an already-built request plan against the back-office server. */
export const executeBackOfficePlan = async (
  plan: BackOfficeRequestPlan,
  config: BackOfficeClientConfig,
): Promise<BackOfficeToolResult> => {
  const doFetch = config.fetchImpl ?? fetch;
  const url = `${stripTrailingSlash(config.baseUrl)}${plan.path}`;
  const headers: Record<string, string> = { "X-API-Key": config.apiKey };
  const init: RequestInit = { method: plan.method, headers };
  if (plan.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(plan.body);
  }

  const response = await doFetch(url, init);
  const text = await response.text();
  let data: unknown = text;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    toolName: plan.toolName,
    mutates: plan.mutates,
    data,
  };
};

/** Convenience: validate the tool call, then execute it. */
export const executeBackOfficeTool = async (
  name: string,
  args: Record<string, unknown>,
  config: BackOfficeClientConfig,
): Promise<BackOfficeToolResult> => {
  const plan = buildBackOfficeRequest(name, args);
  return executeBackOfficePlan(plan, config);
};
