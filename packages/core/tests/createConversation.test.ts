import { describe, expect, it } from "vitest";

import {
  CreateConversationError,
  buildCreateConversationRequest,
} from "../src/application/createConversation";

describe("create-conversation adapter (#45 Phase 3 [D9] chat 'start a conversation')", () => {
  it("requires a non-empty string initialPrompt (parity with legacy 400 'agent_id is required')", () => {
    // A chat session with no initialPrompt never starts a live Claude Code session, so it could
    // not receive a chat turn — the octogent-native form of legacy's required binding.
    expect(() => buildCreateConversationRequest({})).toThrow(CreateConversationError);
    expect(() => buildCreateConversationRequest({ initialPrompt: "" })).toThrow(
      CreateConversationError,
    );
    expect(() => buildCreateConversationRequest({ initialPrompt: "   \n\t" })).toThrow(
      CreateConversationError,
    );
    expect(() => buildCreateConversationRequest({ initialPrompt: 42 })).toThrow(
      CreateConversationError,
    );
    expect(() => buildCreateConversationRequest({})).toThrow("initialPrompt is required");
  });

  it("normalizes a minimal request: trims the prompt, defaults workspaceMode to 'shared'", () => {
    const normalized = buildCreateConversationRequest({
      initialPrompt: "  You are the CEO tentacle.  ",
    });
    expect(normalized.initialPrompt).toBe("You are the CEO tentacle.");
    expect(normalized.workspaceMode).toBe("shared");
    // No title supplied → no tentacleName (createTerminal auto-names the session).
    expect(normalized.tentacleName).toBeUndefined();
  });

  it("carries a non-empty title through as the tentacle name (trimmed)", () => {
    const normalized = buildCreateConversationRequest({
      initialPrompt: "seed",
      title: "  Launch planning  ",
    });
    expect(normalized.tentacleName).toBe("Launch planning");
  });

  it("drops an empty/whitespace title (falls back to auto-naming, no tentacleName)", () => {
    const normalized = buildCreateConversationRequest({ initialPrompt: "seed", title: "   " });
    expect(normalized.tentacleName).toBeUndefined();
  });

  it("accepts an explicit valid workspaceMode and rejects an unknown one", () => {
    expect(
      buildCreateConversationRequest({ initialPrompt: "seed", workspaceMode: "worktree" })
        .workspaceMode,
    ).toBe("worktree");
    expect(() =>
      buildCreateConversationRequest({ initialPrompt: "seed", workspaceMode: "sandbox" }),
    ).toThrow(CreateConversationError);
    expect(() => buildCreateConversationRequest({ initialPrompt: "seed", title: 7 })).toThrow(
      CreateConversationError,
    );
  });
});
