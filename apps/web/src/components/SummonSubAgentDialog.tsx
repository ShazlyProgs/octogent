import { useEffect, useMemo, useState } from "react";

import {
  AGENT_PRESETS,
  VAULT_BUCKETS,
  getBucketsById,
  suggestDisplayName,
  toSlug,
} from "../app/vault-structure";

type SummonSubAgentDialogProps = {
  parentTerminalId: string;
  onCancel: () => void;
  onSummon: (args: {
    parentTerminalId: string;
    buckets: string[];
    displayName: string;
    slug: string;
    purpose: string;
    /**
     * Optional prompt template override (relative to $OCTOGENT/prompts/).
     * Set when a preset is used. Backend uses this instead of the default
     * vault-subagent-init.md if provided.
     */
    promptTemplate?: string;
    /**
     * When true, spawn a bare Claude Code session with no initial prompt
     * (no boot ritual). Used for general-purpose agents where the user
     * wants a plain Claude Code experience keyed to cwd.
     */
    skipInitialPrompt?: boolean;
  }) => Promise<void> | void;
};

export const SummonSubAgentDialog = ({
  parentTerminalId,
  onCancel,
  onSummon,
}: SummonSubAgentDialogProps) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [purpose, setPurpose] = useState("");
  const [nameOverride, setNameOverride] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [promptTemplate, setPromptTemplate] = useState<string | undefined>(undefined);
  const [skipInitialPrompt, setSkipInitialPrompt] = useState<boolean>(false);

  const selectedBuckets = useMemo(() => getBucketsById(Array.from(selected)), [selected]);
  const autoName = useMemo(() => suggestDisplayName(selectedBuckets), [selectedBuckets]);
  const effectiveName = nameOverride.trim() || autoName;
  const slug = toSlug(effectiveName);

  // General-purpose presets (skipInitialPrompt) don't require bucket selection
  // — the agent is meant to behave like a plain Claude Code session, so scope
  // comes from cwd rather than memory-file buckets.
  const canSubmit =
    (skipInitialPrompt || selected.size > 0) && slug.length > 0 && !isSubmitting;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const toggle = (id: string) => {
    // Any manual bucket toggle clears the active preset — user is diverging.
    setActivePresetId(null);
    setPromptTemplate(undefined);
    setSkipInitialPrompt(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const applyPreset = (presetId: string) => {
    const preset = AGENT_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setSelected(new Set(preset.buckets));
    setPurpose(preset.purpose);
    setNameOverride(preset.displayName);
    setActivePresetId(preset.id);
    setPromptTemplate(preset.promptTemplate);
    setSkipInitialPrompt(preset.skipInitialPrompt ?? false);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      const baseArgs = {
        parentTerminalId,
        buckets: Array.from(selected),
        displayName: effectiveName,
        slug,
        purpose: purpose.trim(),
      };
      const withTemplate = promptTemplate
        ? { ...baseArgs, promptTemplate }
        : baseArgs;
      const finalArgs = skipInitialPrompt
        ? { ...withTemplate, skipInitialPrompt: true }
        : withTemplate;
      await onSummon(finalArgs);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Summon Sub-Agent"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          background: "#1a1a1a",
          color: "#e0e0e0",
          padding: "24px 28px",
          borderRadius: 8,
          width: 560,
          maxHeight: "85vh",
          overflow: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          border: "1px solid #333",
        }}
      >
        <h2 style={{ margin: "0 0 8px 0", fontSize: 18 }}>Summon Sub-Agent</h2>
        <p style={{ margin: "0 0 16px 0", fontSize: 13, color: "#aaa" }}>
          Pick a preset for common workflows, or build a custom scope by selecting buckets.
        </p>

        {AGENT_PRESETS.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "#aaa", marginBottom: 6 }}>Quick presets</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {AGENT_PRESETS.map((preset) => {
                const isActive = activePresetId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset.id)}
                    title={preset.tagline}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 4,
                      border: isActive ? "1px solid #d4a017" : "1px solid #444",
                      background: isActive ? "rgba(212,160,23,0.15)" : "#0f0f0f",
                      color: isActive ? "#d4a017" : "#ddd",
                      cursor: "pointer",
                      fontSize: 12,
                      textAlign: "left",
                      minWidth: 200,
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 2 }}>{preset.displayName}</div>
                    <div style={{ fontSize: 11, color: isActive ? "#d4a017" : "#888" }}>
                      {preset.tagline}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "#aaa", marginBottom: 6 }}>Scope (required)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {VAULT_BUCKETS.map((bucket) => (
              <label
                key={bucket.id}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: 4,
                  cursor: "pointer",
                  background: selected.has(bucket.id) ? "rgba(212,160,23,0.15)" : "transparent",
                  border: selected.has(bucket.id) ? "1px solid #d4a017" : "1px solid transparent",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(bucket.id)}
                  onChange={() => toggle(bucket.id)}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{bucket.displayName}</div>
                  <div style={{ fontSize: 11, color: "#888" }}>{bucket.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label
            htmlFor="summon-purpose"
            style={{ display: "block", fontSize: 12, color: "#aaa", marginBottom: 4 }}
          >
            Purpose / primary directive (optional)
          </label>
          <textarea
            id="summon-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={2}
            placeholder="e.g. Audit all Farid briefings and cross-link to Operations tasks"
            style={{
              width: "100%",
              background: "#111",
              color: "#e0e0e0",
              border: "1px solid #333",
              borderRadius: 4,
              padding: 8,
              fontSize: 13,
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label
            htmlFor="summon-name"
            style={{ display: "block", fontSize: 12, color: "#aaa", marginBottom: 4 }}
          >
            Display name (auto-generated, editable)
          </label>
          <input
            id="summon-name"
            type="text"
            value={nameOverride || autoName}
            onChange={(e) => setNameOverride(e.target.value)}
            style={{
              width: "100%",
              background: "#111",
              color: "#e0e0e0",
              border: "1px solid #333",
              borderRadius: 4,
              padding: 8,
              fontSize: 13,
              fontFamily: "inherit",
            }}
          />
          <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
            Tentacle id: <code>{slug || "—"}</code>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            style={{
              padding: "8px 14px",
              borderRadius: 4,
              border: "1px solid #444",
              background: "transparent",
              color: "#ddd",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              padding: "8px 14px",
              borderRadius: 4,
              border: "1px solid #d4a017",
              background: canSubmit ? "#d4a017" : "#444",
              color: canSubmit ? "#111" : "#888",
              cursor: canSubmit ? "pointer" : "not-allowed",
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            {isSubmitting ? "Summoning..." : "Summon"}
          </button>
        </div>
      </div>
    </div>
  );
};
