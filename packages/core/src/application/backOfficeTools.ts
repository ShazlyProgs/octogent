/**
 * Back-office tool registry — pure domain for the #45 W-ORCH-NATIVE Phase 2 "tools" seam.
 *
 * The retired :3001 delegation engine collapses to a back-office SERVICES layer
 * (decision doc §8 end-state). The octogent-native fleet consumes those services as
 * TOOLS — never modifying them. This module is the CURATED, framework-agnostic contract
 * for that seam: it declares each callable back-office tool (name, the live :3001 HTTP
 * endpoint it maps to, and its input schema) and turns a tool call into a validated,
 * transport-agnostic request PLAN. It performs no I/O — the HTTP client + env/auth wiring
 * live in apps/api (ports-and-adapters boundary).
 *
 * DELIBERATELY EXCLUDED: the legacy engine tools (execute / delegate / chat). Those are
 * being retired by #45; exposing them here would let the fleet call the very engine it
 * replaces (csuite-agent-init.md § Delegation model). Only the KEEP-list back-office
 * services (decision doc §3) appear — currently CRM (routes/crm.ts) and Sara voice
 * (routes/voice.ts). WhatsApp/`cfo` (signed inbound bridge) and the CollegaRAG KB
 * (separate loopback MCP, not a :3001 REST route) are follow-ups — see fleet/BACKOFFICE-TOOLS.md.
 */

export type BackOfficeService = "crm" | "voice";

export type BackOfficeMethod = "GET" | "POST" | "PUT" | "DELETE";

export type BackOfficeParamType = "string" | "number" | "boolean" | "object";

export type BackOfficeParamSpec = {
  name: string;
  type: BackOfficeParamType;
  description: string;
  /** Query/body params default to optional; path params are always required. */
  required?: boolean;
  /** Advertised to the agent as a JSON-schema enum. */
  enum?: string[];
};

export type BackOfficeToolDefinition = {
  /** Stable tool name the fleet calls (kebab/underscore, service-prefixed). */
  name: string;
  service: BackOfficeService;
  method: BackOfficeMethod;
  /** Path template against the :3001 base, e.g. "/api/crm/leads/:id". */
  pathTemplate: string;
  description: string;
  /** true for endpoints that mutate state — the fleet treats these as write ops. */
  mutates: boolean;
  /** Path params substituted into :placeholders (always required). */
  pathParams?: BackOfficeParamSpec[];
  /** Query-string filters (GET). Omitted from the URL when the arg is absent. */
  queryParams?: BackOfficeParamSpec[];
  /** JSON body fields (POST/PUT). */
  bodyParams?: BackOfficeParamSpec[];
};

export type BackOfficeRequestPlan = {
  toolName: string;
  method: BackOfficeMethod;
  /** Resolved path + query string relative to the :3001 base, e.g. "/api/crm/leads?limit=10". */
  path: string;
  /** JSON body for POST/PUT; undefined when there is nothing to send. */
  body?: Record<string, unknown>;
  /** Mirrors the tool's mutates flag so the caller can gate write ops. */
  mutates: boolean;
};

export class BackOfficeToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackOfficeToolError";
  }
}

// ---------------------------------------------------------------------------
// The curated registry (grounded against CollegaAgents_CollegaOrchestration
// server/routes/{crm,voice}.ts — do not advertise endpoints the backend lacks).
// ---------------------------------------------------------------------------

const PIPELINE_STAGES = [
  "prospect",
  "qualified",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
];

const BACK_OFFICE_TOOLS: BackOfficeToolDefinition[] = [
  // ---- CRM / waitlist (routes/crm.ts) ------------------------------------
  {
    name: "crm_list_leads",
    service: "crm",
    method: "GET",
    pathTemplate: "/api/crm/leads",
    description: "List CRM leads, optionally filtered by pipeline stage or tenant.",
    mutates: false,
    queryParams: [
      {
        name: "stage",
        type: "string",
        description: "Filter by pipeline stage",
        enum: PIPELINE_STAGES,
      },
      { name: "tenant_id", type: "string", description: "Filter by tenant id" },
      { name: "limit", type: "number", description: "Max leads (default 50)" },
      { name: "offset", type: "number", description: "Pagination offset (default 0)" },
    ],
  },
  {
    name: "crm_get_lead",
    service: "crm",
    method: "GET",
    pathTemplate: "/api/crm/leads/:id",
    description: "Get a single CRM lead by id.",
    mutates: false,
    pathParams: [{ name: "id", type: "string", description: "Lead id", required: true }],
  },
  {
    name: "crm_pipeline",
    service: "crm",
    method: "GET",
    pathTemplate: "/api/crm/pipeline",
    description: "Get lead counts per pipeline stage.",
    mutates: false,
    queryParams: [{ name: "tenant_id", type: "string", description: "Scope to a tenant" }],
  },
  {
    name: "crm_list_lead_activities",
    service: "crm",
    method: "GET",
    pathTemplate: "/api/crm/leads/:id/activities",
    description: "Get the activity timeline for a lead.",
    mutates: false,
    pathParams: [{ name: "id", type: "string", description: "Lead id", required: true }],
  },
  {
    name: "crm_list_lead_appointments",
    service: "crm",
    method: "GET",
    pathTemplate: "/api/crm/leads/:id/appointments",
    description: "Get scheduled appointments for a lead.",
    mutates: false,
    pathParams: [{ name: "id", type: "string", description: "Lead id", required: true }],
  },
  {
    name: "crm_create_lead",
    service: "crm",
    method: "POST",
    pathTemplate: "/api/crm/leads",
    description: "Create a new CRM lead. Only `name` is required.",
    mutates: true,
    bodyParams: [
      { name: "name", type: "string", description: "Lead name", required: true },
      { name: "company", type: "string", description: "Company" },
      { name: "email", type: "string", description: "Email" },
      { name: "phone", type: "string", description: "Phone" },
      { name: "source", type: "string", description: "Lead source" },
      { name: "stage", type: "string", description: "Initial stage", enum: PIPELINE_STAGES },
      { name: "score", type: "number", description: "Lead score" },
      { name: "notes", type: "string", description: "Free-text notes" },
    ],
  },
  {
    name: "crm_set_lead_stage",
    service: "crm",
    method: "POST",
    pathTemplate: "/api/crm/leads/:id/stage",
    description: "Move a lead to a new pipeline stage (records a stage_change activity).",
    mutates: true,
    pathParams: [{ name: "id", type: "string", description: "Lead id", required: true }],
    bodyParams: [
      {
        name: "stage",
        type: "string",
        description: "Target stage",
        required: true,
        enum: PIPELINE_STAGES,
      },
    ],
  },
  {
    name: "crm_add_lead_activity",
    service: "crm",
    method: "POST",
    pathTemplate: "/api/crm/leads/:id/activities",
    description: "Append an activity to a lead's timeline.",
    mutates: true,
    pathParams: [{ name: "id", type: "string", description: "Lead id", required: true }],
    bodyParams: [
      { name: "type", type: "string", description: "Activity type", required: true },
      { name: "description", type: "string", description: "Activity description", required: true },
      { name: "metadata", type: "object", description: "Optional structured metadata" },
    ],
  },
  {
    name: "crm_schedule_follow_up",
    service: "crm",
    method: "POST",
    pathTemplate: "/api/crm/leads/:id/follow-up",
    description: "Schedule a follow-up appointment for a lead (default 7 days out).",
    mutates: true,
    pathParams: [{ name: "id", type: "string", description: "Lead id", required: true }],
    bodyParams: [
      { name: "days", type: "number", description: "Days from now (default 7)" },
      { name: "duration_minutes", type: "number", description: "Duration (default 15)" },
      { name: "notes", type: "string", description: "Follow-up notes" },
    ],
  },
  // ---- Sara voice / receptionist (routes/voice.ts) -----------------------
  {
    name: "voice_status",
    service: "voice",
    method: "GET",
    pathTemplate: "/api/voice/status",
    description: "Get the voice/Sara subsystem status.",
    mutates: false,
  },
  {
    name: "voice_list_calls",
    service: "voice",
    method: "GET",
    pathTemplate: "/api/voice/calls",
    description: "List recent phone calls (missed-call log).",
    mutates: false,
    queryParams: [{ name: "limit", type: "number", description: "Max calls 1-100 (default 20)" }],
  },
  {
    name: "voice_reception_mode",
    service: "voice",
    method: "GET",
    pathTemplate: "/api/voice/reception-mode",
    description: "Get the active receptionist mode and the available modes.",
    mutates: false,
  },
];

export const getBackOfficeToolDefinitions = (): BackOfficeToolDefinition[] => [
  ...BACK_OFFICE_TOOLS,
];

export const findBackOfficeTool = (name: string): BackOfficeToolDefinition | undefined =>
  BACK_OFFICE_TOOLS.find((tool) => tool.name === name);

/** JSON-schema `inputSchema` for a tool (for `octogent backoffice describe` / MCP-style listing). */
export const toBackOfficeInputSchema = (
  tool: BackOfficeToolDefinition,
): { type: "object"; properties: Record<string, unknown>; required: string[] } => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const allParams = [
    ...(tool.pathParams ?? []),
    ...(tool.queryParams ?? []),
    ...(tool.bodyParams ?? []),
  ];
  for (const param of allParams) {
    properties[param.name] = {
      type: param.type,
      description: param.description,
      ...(param.enum ? { enum: param.enum } : {}),
    };
    if (param.required || tool.pathParams?.includes(param)) {
      required.push(param.name);
    }
  }
  return { type: "object", properties, required };
};

const coerceScalar = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new BackOfficeToolError(`value ${JSON.stringify(value)} is not a scalar`);
};

/**
 * Validate a tool call and derive a transport-agnostic request plan. Throws
 * BackOfficeToolError on an unknown tool or a missing required argument. Absent
 * optional query/body params are simply omitted (no nulls sent to the backend).
 */
export const buildBackOfficeRequest = (
  name: string,
  args: Record<string, unknown> = {},
): BackOfficeRequestPlan => {
  const tool = findBackOfficeTool(name);
  if (!tool) {
    const available = BACK_OFFICE_TOOLS.map((t) => t.name).join(", ");
    throw new BackOfficeToolError(`Unknown back-office tool "${name}". Available: ${available}`);
  }

  const missing: string[] = [];

  // Path params — always required, substituted into :placeholders.
  let path = tool.pathTemplate;
  for (const param of tool.pathParams ?? []) {
    const value = args[param.name];
    if (value === undefined || value === null || value === "") {
      missing.push(param.name);
      continue;
    }
    path = path.replace(`:${param.name}`, encodeURIComponent(coerceScalar(value)));
  }

  // Query params — appended only when present.
  const query = new URLSearchParams();
  for (const param of tool.queryParams ?? []) {
    const value = args[param.name];
    if (value === undefined || value === null || value === "") {
      if (param.required) missing.push(param.name);
      continue;
    }
    query.set(param.name, coerceScalar(value));
  }

  // Body params — collected for POST/PUT.
  const body: Record<string, unknown> = {};
  for (const param of tool.bodyParams ?? []) {
    const value = args[param.name];
    if (value === undefined || value === null) {
      if (param.required) missing.push(param.name);
      continue;
    }
    body[param.name] = value;
  }

  if (missing.length > 0) {
    throw new BackOfficeToolError(
      `Tool "${name}" is missing required argument(s): ${missing.join(", ")}`,
    );
  }

  const queryString = query.toString();
  const fullPath = queryString ? `${path}?${queryString}` : path;
  const hasBody = Object.keys(body).length > 0;

  return {
    toolName: tool.name,
    method: tool.method,
    path: fullPath,
    ...(hasBody ? { body } : {}),
    mutates: tool.mutates,
  };
};
