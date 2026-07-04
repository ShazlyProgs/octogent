import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/createApiServer";
import {
  extractRequestToken,
  isAuthorizedRequest,
  isMutatingMethod,
  readApiToken,
} from "../src/createApiServer/security";

// OCT-01 — env-gated token auth for the local API (:8787).
// Contract:
//  - OCTOGENT_API_TOKEN unset  → loopback-open, current behaviour preserved.
//  - set                        → mutating verbs (POST/PUT/PATCH/DELETE) require
//                                 the token via Bearer or X-Api-Key; reads open.

describe("security helpers (OCT-01)", () => {
  describe("readApiToken", () => {
    it("returns undefined for unset / empty / whitespace values", () => {
      expect(readApiToken(undefined)).toBeUndefined();
      expect(readApiToken("")).toBeUndefined();
      expect(readApiToken("   ")).toBeUndefined();
    });

    it("trims and returns a real token", () => {
      expect(readApiToken("  s3cret  ")).toBe("s3cret");
    });
  });

  describe("isMutatingMethod", () => {
    it("treats POST/PUT/PATCH/DELETE as mutating (case-insensitive)", () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "patch"]) {
        expect(isMutatingMethod(method)).toBe(true);
      }
    });

    it("treats GET/HEAD/OPTIONS/undefined as non-mutating", () => {
      for (const method of ["GET", "HEAD", "OPTIONS", undefined]) {
        expect(isMutatingMethod(method)).toBe(false);
      }
    });
  });

  describe("extractRequestToken", () => {
    it("reads a bearer token from the Authorization header", () => {
      expect(extractRequestToken("Bearer abc123", undefined)).toBe("abc123");
      expect(extractRequestToken("bearer abc123", undefined)).toBe("abc123");
    });

    it("reads a token from the X-Api-Key header", () => {
      expect(extractRequestToken(undefined, "abc123")).toBe("abc123");
    });

    it("returns undefined when neither header carries a token", () => {
      expect(extractRequestToken(undefined, undefined)).toBeUndefined();
      expect(extractRequestToken("Bearer ", "")).toBeUndefined();
      expect(extractRequestToken("Basic xxx", undefined)).toBeUndefined();
    });
  });

  describe("isAuthorizedRequest", () => {
    const base = {
      authorizationHeader: undefined,
      apiKeyHeader: undefined,
    };

    it("is open when no token is configured (unset)", () => {
      expect(isAuthorizedRequest({ ...base, method: "POST", apiToken: undefined })).toBe(true);
      expect(isAuthorizedRequest({ ...base, method: "DELETE", apiToken: undefined })).toBe(true);
    });

    it("allows non-mutating methods even when a token is configured", () => {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        expect(isAuthorizedRequest({ ...base, method, apiToken: "s3cret" })).toBe(true);
      }
    });

    it("rejects mutating requests with no credential (401 surface)", () => {
      expect(isAuthorizedRequest({ ...base, method: "POST", apiToken: "s3cret" })).toBe(false);
    });

    it("rejects mutating requests with the wrong token", () => {
      expect(
        isAuthorizedRequest({
          ...base,
          method: "POST",
          authorizationHeader: "Bearer wrong",
          apiToken: "s3cret",
        }),
      ).toBe(false);
    });

    it("accepts a correct bearer token on a mutating request", () => {
      expect(
        isAuthorizedRequest({
          ...base,
          method: "POST",
          authorizationHeader: "Bearer s3cret",
          apiToken: "s3cret",
        }),
      ).toBe(true);
    });

    it("accepts a correct X-Api-Key on a mutating request", () => {
      expect(
        isAuthorizedRequest({
          ...base,
          method: "PATCH",
          apiKeyHeader: "s3cret",
          apiToken: "s3cret",
        }),
      ).toBe(true);
    });
  });
});

describe("createApiServer token gate (OCT-01)", () => {
  const TOKEN = "test-token-123";
  let stopServer: (() => Promise<void>) | null = null;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = null;
    }
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  });

  const startServer = async (options: Partial<Parameters<typeof createApiServer>[0]> = {}) => {
    const directory = mkdtempSync(join(tmpdir(), "octogent-authtest-"));
    temporaryDirectories.push(directory);
    const apiServer = createApiServer({ workspaceCwd: directory, ...options });
    const address = await apiServer.start(0, "127.0.0.1");
    stopServer = () => apiServer.stop();
    return `http://${address.host}:${address.port}`;
  };

  const patchUiState = (baseUrl: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/api/ui-state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ minimizedTerminalIds: [] }),
    });

  it("token unset → mutating PATCH is allowed (loopback-open preserved)", async () => {
    const baseUrl = await startServer();
    const response = await patchUiState(baseUrl);
    expect(response.status).toBe(200);
  });

  it("token set + no credential → 401 on a mutating request", async () => {
    const baseUrl = await startServer({ apiToken: TOKEN });
    const response = await patchUiState(baseUrl);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized." });
  });

  it("token set + wrong bearer → 401", async () => {
    const baseUrl = await startServer({ apiToken: TOKEN });
    const response = await patchUiState(baseUrl, { Authorization: "Bearer nope" });
    expect(response.status).toBe(401);
  });

  it("token set + correct bearer → allowed", async () => {
    const baseUrl = await startServer({ apiToken: TOKEN });
    const response = await patchUiState(baseUrl, { Authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
  });

  it("token set + correct X-Api-Key → allowed", async () => {
    const baseUrl = await startServer({ apiToken: TOKEN });
    const response = await patchUiState(baseUrl, { "X-Api-Key": TOKEN });
    expect(response.status).toBe(200);
  });

  it("token set + no credential → DELETE is also gated (method coverage)", async () => {
    const baseUrl = await startServer({ apiToken: TOKEN });
    const response = await fetch(`${baseUrl}/api/terminals/terminal-1`, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    expect(response.status).toBe(401);
  });

  it("token set → read-only GET stays open (no credential required)", async () => {
    const baseUrl = await startServer({ apiToken: TOKEN });
    const response = await fetch(`${baseUrl}/api/terminal-snapshots`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    expect(response.status).toBe(200);
  });

  it("token set → CORS preflight (OPTIONS) stays open", async () => {
    const baseUrl = await startServer({ apiToken: TOKEN });
    const response = await fetch(`${baseUrl}/api/ui-state`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "PATCH",
      },
    });
    expect(response.status).toBe(204);
  });
});
