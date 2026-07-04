import { describe, expect, it } from "vitest";

import {
  CONVERSATION_TITLE_MAX_LENGTH,
  ConversationRenameError,
  buildConversationRename,
} from "../src/application/renameConversation";

describe("rename-conversation adapter (#45 Phase 3 [D9] chat 'rename metadata')", () => {
  it("rejects a missing / empty / whitespace / non-string title (legacy required-field 400)", () => {
    expect(() => buildConversationRename(undefined)).toThrow(ConversationRenameError);
    expect(() => buildConversationRename("")).toThrow(ConversationRenameError);
    expect(() => buildConversationRename("   \n\t")).toThrow(ConversationRenameError);
    expect(() => buildConversationRename(42)).toThrow(ConversationRenameError);
    expect(() => buildConversationRename(undefined)).toThrow("title is required");
  });

  it("trims the title", () => {
    expect(buildConversationRename("  Launch planning  ").title).toBe("Launch planning");
  });

  it("caps an over-long title at CONVERSATION_TITLE_MAX_LENGTH", () => {
    const long = "x".repeat(CONVERSATION_TITLE_MAX_LENGTH + 50);
    const result = buildConversationRename(long);
    expect(result.title.length).toBe(CONVERSATION_TITLE_MAX_LENGTH);
  });
});
