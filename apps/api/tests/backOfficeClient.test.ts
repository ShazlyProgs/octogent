import { describe, expect, it, vi } from "vitest";

import {
  BackOfficeConfigError,
  executeBackOfficePlan,
  executeBackOfficeTool,
  resolveBackOfficeConfigFromEnv,
} from "../src/backOfficeClient";

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("resolveBackOfficeConfigFromEnv", () => {
  it("reads base url + api key and strips a trailing slash", () => {
    const config = resolveBackOfficeConfigFromEnv({
      COLLEGA_BACKOFFICE_BASE_URL: "http://127.0.0.1:3001/",
      COLLEGA_BACKOFFICE_API_KEY: "k-123",
    } as NodeJS.ProcessEnv);
    expect(config).toEqual({ baseUrl: "http://127.0.0.1:3001", apiKey: "k-123" });
  });

  it("fails closed when the base url is missing", () => {
    expect(() =>
      resolveBackOfficeConfigFromEnv({ COLLEGA_BACKOFFICE_API_KEY: "k" } as NodeJS.ProcessEnv),
    ).toThrow(BackOfficeConfigError);
  });

  it("names every missing var", () => {
    expect(() => resolveBackOfficeConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(
      /COLLEGA_BACKOFFICE_BASE_URL and COLLEGA_BACKOFFICE_API_KEY/,
    );
  });
});

describe("executeBackOfficeTool", () => {
  it("issues an authenticated GET with the resolved path", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ leads: [], total: 0 }));
    const result = await executeBackOfficeTool(
      "crm_list_leads",
      { stage: "qualified", limit: 10 },
      {
        baseUrl: "http://127.0.0.1:3001",
        apiKey: "secret",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3001/api/crm/leads?stage=qualified&limit=10");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("secret");
    expect(init.body).toBeUndefined();
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      toolName: "crm_list_leads",
      mutates: false,
    });
    expect(result.data).toEqual({ leads: [], total: 0 });
  });

  it("sends a JSON body with content-type on a mutating POST", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: "L9", name: "Acme" }, 201));
    const result = await executeBackOfficeTool(
      "crm_create_lead",
      { name: "Acme" },
      {
        baseUrl: "http://127.0.0.1:3001",
        apiKey: "secret",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3001/api/crm/leads");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ name: "Acme" });
    expect(result).toMatchObject({ ok: true, status: 201, mutates: true });
  });

  it("surfaces non-ok responses without throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Lead not found" }, 404));
    const result = await executeBackOfficeTool(
      "crm_get_lead",
      { id: "nope" },
      {
        baseUrl: "http://127.0.0.1:3001",
        apiKey: "secret",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.data).toEqual({ error: "Lead not found" });
  });

  it("propagates validation errors before any fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      executeBackOfficeTool(
        "crm_get_lead",
        {},
        {
          baseUrl: "http://127.0.0.1:3001",
          apiKey: "secret",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      ),
    ).rejects.toThrow(/missing required/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("executeBackOfficePlan — non-JSON body", () => {
  it("returns raw text when the response is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("BEGIN:VCALENDAR", { status: 200 }));
    const result = await executeBackOfficePlan(
      { toolName: "x", method: "GET", path: "/api/x", mutates: false },
      {
        baseUrl: "http://127.0.0.1:3001",
        apiKey: "secret",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(result.data).toBe("BEGIN:VCALENDAR");
  });
});
