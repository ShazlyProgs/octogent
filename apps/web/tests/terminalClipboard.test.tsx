import { describe, expect, it, vi } from "vitest";

import {
  copySelectionToClipboard,
  createCopyKeyHandler,
} from "../src/components/terminalClipboard";

type MockTerminal = {
  hasSelection: () => boolean;
  getSelection: () => string;
};

const makeTerminal = (selection: string): MockTerminal => ({
  hasSelection: () => selection.length > 0,
  getSelection: () => selection,
});

const makeClipboard = () => {
  const writes: string[] = [];
  return {
    writes,
    writeText: vi.fn((text: string) => {
      writes.push(text);
      return Promise.resolve();
    }),
  };
};

const keyEvent = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("copySelectionToClipboard", () => {
  it("writes the selection to the clipboard", () => {
    const clipboard = makeClipboard();
    copySelectionToClipboard(makeTerminal("hello world"), clipboard);
    expect(clipboard.writes).toEqual(["hello world"]);
  });

  it("is a no-op when there is no selection", () => {
    const clipboard = makeClipboard();
    expect(copySelectionToClipboard(makeTerminal(""), clipboard)).toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("is a no-op when the clipboard API is unavailable", () => {
    expect(copySelectionToClipboard(makeTerminal("hello"), undefined)).toBe(false);
    expect(copySelectionToClipboard(makeTerminal("hello"), null)).toBe(false);
  });

  it("is a no-op when the selection text is empty", () => {
    // hasSelection true but getSelection "" — defensive
    const terminal = { hasSelection: () => true, getSelection: () => "" };
    const clipboard = makeClipboard();
    expect(copySelectionToClipboard(terminal, clipboard)).toBe(false);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("swallows clipboard rejection without throwing", () => {
    const rejecting = { writeText: () => Promise.reject(new Error("denied")) };
    expect(() => copySelectionToClipboard(makeTerminal("hello"), rejecting)).not.toThrow();
  });
});

describe("createCopyKeyHandler", () => {
  it("copies and suppresses xterm on Ctrl+Shift+C with a selection", () => {
    const clipboard = makeClipboard();
    const handler = createCopyKeyHandler(makeTerminal("selected"), clipboard);
    const result = handler(keyEvent({ key: "c", ctrlKey: true, shiftKey: true }));
    expect(result).toBe(false);
    expect(clipboard.writes).toEqual(["selected"]);
  });

  it("copies and suppresses xterm on Cmd+C (mac) with a selection", () => {
    const clipboard = makeClipboard();
    const handler = createCopyKeyHandler(makeTerminal("selected"), clipboard);
    const result = handler(keyEvent({ key: "c", metaKey: true }));
    expect(result).toBe(false);
    expect(clipboard.writes).toEqual(["selected"]);
  });

  it("leaves plain Ctrl+C untouched so SIGINT (\\x03) still reaches the PTY", () => {
    const clipboard = makeClipboard();
    const handler = createCopyKeyHandler(makeTerminal("selected"), clipboard);
    const result = handler(keyEvent({ key: "c", ctrlKey: true }));
    expect(result).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("lets xterm handle the copy shortcut when nothing is selected", () => {
    const clipboard = makeClipboard();
    const handler = createCopyKeyHandler(makeTerminal(""), clipboard);
    expect(handler(keyEvent({ key: "c", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(handler(keyEvent({ key: "c", metaKey: true }))).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("lets xterm handle unrelated keys", () => {
    const clipboard = makeClipboard();
    const handler = createCopyKeyHandler(makeTerminal("selected"), clipboard);
    expect(handler(keyEvent({ key: "a" }))).toBe(true);
    expect(handler(keyEvent({ key: "v", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});
