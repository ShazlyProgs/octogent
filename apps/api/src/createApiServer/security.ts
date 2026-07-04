import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// OCT-01 hardening: methods that create/mutate state (spawn PTYs, send channel
// messages, mutate git/worktrees, patch UI state). When OCTOGENT_API_TOKEN is
// set these require a bearer token / API key; read-only GET/HEAD and OPTIONS
// preflight stay open so the local dashboard keeps polling telemetry.
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const BEARER_PREFIX = "bearer ";

export const withCors = (headers: Record<string, string>, corsOrigin: string | null) => {
  const nextHeaders: Record<string, string> = {
    ...headers,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (corsOrigin) {
    nextHeaders["Access-Control-Allow-Origin"] = corsOrigin;
    nextHeaders.Vary = "Origin";
  }

  return nextHeaders;
};

const isLoopbackHostname = (hostname: string) => LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

const parseHostname = (value: string, withScheme: boolean): string | null => {
  try {
    const url = new URL(withScheme ? value : `http://${value}`);
    return url.hostname;
  } catch {
    return null;
  }
};

export const isAllowedOriginHeader = (origin: string | undefined, allowRemoteAccess: boolean) => {
  if (allowRemoteAccess || origin === undefined) {
    return true;
  }

  const hostname = parseHostname(origin, true);
  return hostname !== null && isLoopbackHostname(hostname);
};

export const isAllowedHostHeader = (host: string | undefined, allowRemoteAccess: boolean) => {
  if (allowRemoteAccess) {
    return true;
  }

  if (!host) {
    return false;
  }

  const hostname = parseHostname(host, false);
  return hostname !== null && isLoopbackHostname(hostname);
};

export const readHeaderValue = (header: string | string[] | undefined): string | undefined => {
  if (typeof header !== "string") {
    return undefined;
  }

  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const getRequestCorsOrigin = (origin: string | undefined, allowRemoteAccess: boolean) => {
  if (!origin) {
    return null;
  }

  if (!allowRemoteAccess && !isAllowedOriginHeader(origin, allowRemoteAccess)) {
    return null;
  }

  return origin;
};

// ---------------------------------------------------------------------------
// OCT-01 — optional token auth for the local API (env: OCTOGENT_API_TOKEN).
//
// Unset (the default, and what the live fleet uses) → behaviour is unchanged:
// every request is allowed once it clears the loopback Host/Origin checks.
//
// Set → mutating requests (POST/PUT/PATCH/DELETE) must present the token via
// `Authorization: Bearer <token>` or `X-Api-Key: <token>`. Read-only requests
// (GET/HEAD) and CORS preflight (OPTIONS) stay open. Activation is Mohamed-gated
// (see docs/HARDENING.md OCT-01); the octogent daemon must be restarted with the
// env var present for the token to take effect.
// ---------------------------------------------------------------------------

/** Normalise a raw env value into a token, treating empty/whitespace as unset. */
export const readApiToken = (rawToken: string | undefined): string | undefined => {
  if (typeof rawToken !== "string") {
    return undefined;
  }
  const trimmed = rawToken.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const isMutatingMethod = (method: string | undefined): boolean =>
  method !== undefined && MUTATING_METHODS.has(method.toUpperCase());

/** Extract a presented token from an `Authorization: Bearer` or `X-Api-Key` header. */
export const extractRequestToken = (
  authorizationHeader: string | undefined,
  apiKeyHeader: string | undefined,
): string | undefined => {
  if (authorizationHeader?.toLowerCase().startsWith(BEARER_PREFIX)) {
    const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
    if (token.length > 0) {
      return token;
    }
  }

  if (apiKeyHeader) {
    const token = apiKeyHeader.trim();
    if (token.length > 0) {
      return token;
    }
  }

  return undefined;
};

/** Constant-time string comparison that tolerates unequal lengths. */
const timingSafeStringEqual = (a: string, b: string): boolean => {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
};

type AuthorizeRequestInput = {
  method: string | undefined;
  authorizationHeader: string | undefined;
  apiKeyHeader: string | undefined;
  apiToken: string | undefined;
};

/**
 * Returns true when the request is authorised.
 * - apiToken unset → always authorised (loopback-open, current behaviour).
 * - non-mutating method → authorised (read/telemetry + OPTIONS preflight).
 * - mutating method → requires a presented token matching apiToken.
 */
export const isAuthorizedRequest = ({
  method,
  authorizationHeader,
  apiKeyHeader,
  apiToken,
}: AuthorizeRequestInput): boolean => {
  if (!apiToken) {
    return true;
  }

  if (!isMutatingMethod(method)) {
    return true;
  }

  const presented = extractRequestToken(authorizationHeader, apiKeyHeader);
  if (presented === undefined) {
    return false;
  }

  return timingSafeStringEqual(presented, apiToken);
};
