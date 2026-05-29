/**
 * Vault structure — canonical bucket list.
 * Mirror of $VAULT/.shazly/VAULT-STRUCTURE.md. Keep in sync.
 *
 * Each bucket is a scope domain (paths + priority memory files).
 * When Mohamed picks one or more buckets in the Summon Sub-Agent dialog,
 * the sub-agent inherits the union of those buckets' scopes.
 */
export type VaultBucket = {
  id: string;
  displayName: string;
  description: string;
  /** Paths (may use $SYMBOL references; resolved at boot via REPOS.md). */
  paths: string[];
  /** Priority memory files for this bucket (filenames only, relative to $MEMORY/). */
  memoryFiles: string[];
};

export const VAULT_BUCKETS: VaultBucket[] = [
  {
    id: "operations",
    displayName: "Operations (daily ops)",
    description:
      "Mohamed's day-to-day operational layer — 00-Work, Claude Cowork, TASKS.md, 40-Plans, MOCs.",
    paths: [
      "$VAULT/00-Work/",
      "$VAULT/Claude Cowork/",
      "$VAULT/TASKS.md",
      "$VAULT/40-Plans/",
      "$VAULT/MOC - *.md",
    ],
    memoryFiles: [
      "project_strategic_input_friday.md",
      "project_collega_cpo_objectives.md",
      "feedback_vault_structure.md",
      "feedback_session_closing_protocol.md",
      "user_profile.md",
    ],
  },
  {
    id: "knowledge",
    displayName: "Knowledge (reference notes)",
    description:
      "30-Knowledge — Farid briefings by project code, domain wisdom, source-of-truth document copies.",
    paths: ["$KNOWLEDGE/"],
    memoryFiles: [
      "reference_terms_products.md",
      "reference_contacts_internal.md",
      "reference_contacts_external.md",
    ],
  },
  {
    id: "client-delivery",
    displayName: "Client Delivery (Farid GE work)",
    description:
      "10-Client-Delivery — Mohamed's deliverables as General Engineer for Farid consulting.",
    paths: ["$VAULT/10-Client-Delivery/"],
    memoryFiles: [
      "reference_contacts_internal.md",
      "reference_contacts_external.md",
      "reference_terms_products.md",
      "project_farid_international_sales_use_case.md",
    ],
  },
  {
    id: "tenants",
    displayName: "SaaS Tenants (per-tenant Collega)",
    description:
      "20-Tenants — per-tenant SaaS content (config, dsl, personas). Empty today; grows with onboarding.",
    paths: ["$VAULT/20-Tenants/"],
    memoryFiles: [
      "project_saas_vision.md",
      "project_farid_international_sales_use_case.md",
      "project_retention_architecture.md",
    ],
  },
  {
    id: "collega-products",
    displayName: "Collega Products (RAG + Agents + Orchestration)",
    description:
      "The three-product portfolio. Code work follows validation-period rule — delegate via POST /api/execute.",
    paths: ["$RAG", "$AGENTS", "$ORCHESTRATION"],
    memoryFiles: [
      "reference_product_taxonomy.md",
      "project_saas_vision.md",
      "project_collega_cpo_objectives.md",
      "project_retention_architecture.md",
      "project_yc_application.md",
      "project_feedback_to_agents.md",
      "project_phone_call_tool.md",
      "project_website_hosting.md",
      "project_website_pitch_points.md",
    ],
  },
  {
    id: "octogent",
    displayName: "ShazlyAgent Tool (this framework)",
    description:
      "ShazlyAgent source — framework code, prompts, scripts, PLAYBOOK, REPOS. Meta-orchestration layer.",
    paths: ["$OCTOGENT"],
    memoryFiles: ["project_shazly_agent_framework.md"],
  },
  {
    id: "farid-rd",
    displayName: "Farid R&D (employer projects)",
    description:
      "AttentionAssist, DataCollectionKit — Raspberry Pi-based R&D for Farid Industrie.",
    paths: ["$FARID_DEV"],
    memoryFiles: [
      "reference_contacts_internal.md",
      "reference_terms_products.md",
      "project_raspberry_pi_voice_agent.md",
    ],
  },
  {
    id: "hobby",
    displayName: "Hobby (personal code)",
    description: "pixel-agents (VS Code extension), pst-to-obsidian (vault utility).",
    paths: ["$HOBBY"],
    memoryFiles: [],
  },
  {
    id: "personal-pocs",
    displayName: "Personal PoCs (non-engineering)",
    description: "Fresh Start (career docs), work-briefing (Outlook scraper), VlmPoC (VLM experiments).",
    paths: ["$PERSONAL"],
    memoryFiles: [],
  },
  {
    id: "vault-meta",
    displayName: "Vault Meta (framework governance)",
    description:
      ".shazly/, MEMORY, CLAUDE.mds, docs/, ADRs, context-warnings — the rules and meta layer.",
    paths: [
      "$VAULT/.shazly/",
      "$VAULT/CLAUDE.md",
      "$ORCHESTRATION/CLAUDE.md",
      "$ORCHESTRATION/docs/",
      "$ORCHESTRATION/.claude-flow/context-warnings.md",
      "$MEMORY/",
    ],
    memoryFiles: [], // special case — vault-meta implies "all memory"
  },
];

export const getBucketsById = (ids: string[]): VaultBucket[] =>
  ids
    .map((id) => VAULT_BUCKETS.find((b) => b.id === id))
    .filter((b): b is VaultBucket => b !== undefined);

/**
 * Derive a display name from selected bucket IDs.
 * Single bucket → e.g. "WorkAgent".
 * Multi bucket → e.g. "Operations+Knowledge Agent".
 */
export const suggestDisplayName = (buckets: VaultBucket[]): string => {
  if (buckets.length === 0) return "SubAgent";
  const first = buckets[0];
  if (buckets.length === 1 && first) {
    // Strip parenthetical, capitalize first word
    const base = (first.displayName.split("(")[0] ?? first.displayName).trim();
    return base.replace(/\s+/g, "").replace(/^./, (c) => c.toUpperCase()) + "Agent";
  }
  const parts = buckets.map((b) => {
    const word = b.displayName.split(" ")[0] ?? "";
    return word.replace(/[^A-Za-z0-9]/g, "");
  });
  return parts.join("+") + "Agent";
};

/**
 * Derive a slug (tentacleId) from display name.
 * e.g. "Operations+KnowledgeAgent" → "operations-knowledge-agent".
 */
export const toSlug = (displayName: string): string =>
  displayName
    .toLowerCase()
    .replace(/\+/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Named one-click presets for the Summon dialog.
 *
 * Each preset pre-fills buckets + display name + purpose + optionally an alternate
 * init prompt template. Purely additive to the free-form picker — the user can
 * still tweak anything before summoning.
 *
 * Source of truth for what each preset does: see the referenced prompt file
 * under $OCTOGENT/prompts/.
 */
export type AgentPreset = {
  id: string;
  displayName: string;
  /** One-line description shown on the preset button. */
  tagline: string;
  /** Bucket ids this preset pre-selects. */
  buckets: string[];
  /** Pre-filled purpose (editable). */
  purpose: string;
  /**
   * Optional override prompt filename (relative to $OCTOGENT/prompts/).
   * If unset, the backend uses the default vault-subagent-init.md.
   * When set, the backend should pick this prompt instead.
   */
  promptTemplate?: string;
  /**
   * If true, skip the octogent boot ritual entirely — no initial prompt,
   * no promptTemplate. The spawned Claude gets a vanilla Claude Code boot
   * (CLAUDE.md chain + auto-memory + MCPs per cwd), identical to opening
   * Claude Code directly in that directory. Use for general-purpose agents.
   */
  skipInitialPrompt?: boolean;
};

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: "claude-code-agent",
    displayName: "ClaudeCodeAgent",
    tagline: "General Claude Code session — no preset ritual, behaves by cwd (vault root by default)",
    buckets: [],
    purpose: "",
    skipInitialPrompt: true,
  },
  {
    id: "vaultsync-swarm",
    displayName: "VaultSyncSwarm",
    tagline: "Scan whole vault — swarm (one terminal per scanner, visible on canvas)",
    buckets: ["vault-meta"],
    purpose:
      "Run a full swarm audit per $VAULT/.shazly/VAULT-SYNC-PLAN.md. Fan out one ShazlyAgent terminal child per scanner (up to 9 per wave). Each scanner writes its findings to a scanner-specific JSON. You aggregate, produce report, and close. Do not apply fixes unless the user explicitly says 'apply mode'.",
    promptTemplate: "vaultsync-swarm-init",
  },
];

export const getPresetById = (id: string): AgentPreset | undefined =>
  AGENT_PRESETS.find((p) => p.id === id);
