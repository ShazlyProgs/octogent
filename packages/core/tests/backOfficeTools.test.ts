import { describe, expect, it } from "vitest";

import {
  BackOfficeToolError,
  buildBackOfficeRequest,
  findBackOfficeTool,
  getBackOfficeToolDefinitions,
  toBackOfficeInputSchema,
} from "../src/application/backOfficeTools";

describe("back-office tool registry", () => {
  it("exposes only KEEP-list services (crm + voice), never engine tools", () => {
    const tools = getBackOfficeToolDefinitions();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(["crm", "voice"]).toContain(tool.service);
      // Engine tools (retired by #45) must never leak into the fleet's tool surface.
      expect(tool.name).not.toMatch(/delegate|execute|chat/);
    }
  });

  it("has unique tool names and valid HTTP methods", () => {
    const tools = getBackOfficeToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(["GET", "POST", "PUT", "DELETE"]).toContain(tool.method);
      // Every :placeholder in the path has a matching required path param.
      const placeholders = [...tool.pathTemplate.matchAll(/:([a-zA-Z_]+)/g)].map((m) => m[1]);
      const declared = (tool.pathParams ?? []).map((p) => p.name);
      expect(declared.sort()).toEqual(placeholders.sort());
    }
  });

  it("returns a copy from getBackOfficeToolDefinitions (no shared mutation)", () => {
    const a = getBackOfficeToolDefinitions();
    a.pop();
    expect(getBackOfficeToolDefinitions().length).toBe(a.length + 1);
  });
});

describe("buildBackOfficeRequest — GET with query", () => {
  it("omits absent optional query params", () => {
    const plan = buildBackOfficeRequest("crm_list_leads", {});
    expect(plan).toEqual({
      toolName: "crm_list_leads",
      method: "GET",
      path: "/api/crm/leads",
      mutates: false,
    });
  });

  it("appends present query params", () => {
    const plan = buildBackOfficeRequest("crm_list_leads", { stage: "qualified", limit: 10 });
    expect(plan.path).toBe("/api/crm/leads?stage=qualified&limit=10");
    expect(plan.body).toBeUndefined();
  });

  it("coerces numeric query values to strings", () => {
    const plan = buildBackOfficeRequest("voice_list_calls", { limit: 5 });
    expect(plan.path).toBe("/api/voice/calls?limit=5");
  });
});

describe("buildBackOfficeRequest — path params", () => {
  it("substitutes and url-encodes the path param", () => {
    const plan = buildBackOfficeRequest("crm_get_lead", { id: "lead 42/x" });
    expect(plan.path).toBe("/api/crm/leads/lead%2042%2Fx");
    expect(plan.method).toBe("GET");
  });

  it("throws when a required path param is missing", () => {
    expect(() => buildBackOfficeRequest("crm_get_lead", {})).toThrow(BackOfficeToolError);
    expect(() => buildBackOfficeRequest("crm_get_lead", { id: "" })).toThrow(/missing required/i);
  });
});

describe("buildBackOfficeRequest — body (POST/PUT)", () => {
  it("collects present body params and marks mutating tools", () => {
    const plan = buildBackOfficeRequest("crm_create_lead", {
      name: "Acme",
      email: "a@b.co",
      score: 7,
    });
    expect(plan.method).toBe("POST");
    expect(plan.path).toBe("/api/crm/leads");
    expect(plan.body).toEqual({ name: "Acme", email: "a@b.co", score: 7 });
    expect(plan.mutates).toBe(true);
  });

  it("throws when a required body param is missing", () => {
    expect(() => buildBackOfficeRequest("crm_create_lead", { email: "a@b.co" })).toThrow(
      /missing required argument\(s\): name/i,
    );
  });

  it("combines path + body for nested POSTs", () => {
    const plan = buildBackOfficeRequest("crm_set_lead_stage", { id: "L1", stage: "proposal" });
    expect(plan.path).toBe("/api/crm/leads/L1/stage");
    expect(plan.body).toEqual({ stage: "proposal" });
  });

  it("reports every missing required arg at once", () => {
    expect(() => buildBackOfficeRequest("crm_add_lead_activity", { id: "L1" })).toThrow(
      /type, description/i,
    );
  });
});

describe("unknown tool", () => {
  it("throws listing available tools", () => {
    expect(() => buildBackOfficeRequest("shazly_delegate", {})).toThrow(
      /Unknown back-office tool/i,
    );
  });
});

describe("toBackOfficeInputSchema", () => {
  const requireTool = (name: string) => {
    const tool = findBackOfficeTool(name);
    if (!tool) throw new Error(`expected tool ${name} to exist`);
    return tool;
  };

  it("builds a JSON schema with required path + required body params", () => {
    const schema = toBackOfficeInputSchema(requireTool("crm_set_lead_stage"));
    expect(schema.type).toBe("object");
    expect(schema.required.sort()).toEqual(["id", "stage"]);
    expect(schema.properties.stage).toMatchObject({ type: "string" });
    expect((schema.properties.stage as { enum: string[] }).enum).toContain("proposal");
  });

  it("has no required entries for a filter-only GET", () => {
    const schema = toBackOfficeInputSchema(requireTool("crm_list_leads"));
    expect(schema.required).toEqual([]);
  });
});
