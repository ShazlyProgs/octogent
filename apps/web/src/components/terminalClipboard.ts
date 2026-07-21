// Copy support for the xterm terminal.
//
// claude runs in a full-screen TUI that enables SGR mouse tracking so the wheel
// can scroll its transcript (see terminalInput.ts / commit bdc84db). While mouse
// tracking is active xterm suppresses plain-drag selection and only Shift+drag
// selects (xterm-native: SelectionService.shouldForceSelection → shiftKey). That
// selection is xterm's own — nothing copies it to the clipboard without help, so
// "select then copy" never worked. These helpers close that gap.

type SelectableTerminal = {
  hasSelection: () => boolean;
  getSelection: () => string;
};

type ClipboardLike = {
  writeText: (text: string) => Promise<void>;
};

/**
 * Copy the terminal's current selection to the clipboard. Returns true when a
 * non-empty selection was handed to the clipboard API. No-op (returns false)
 * when there is no selection, no clipboard API, or the text is empty. The write
 * itself is fire-and-forget — it may reject without a user gesture.
 */
export const copySelectionToClipboard = (
  terminal: SelectableTerminal,
  clipboard: ClipboardLike | undefined | null,
): boolean => {
  if (!clipboard || !terminal.hasSelection()) {
    return false;
  }
  const text = terminal.getSelection();
  if (!text) {
    return false;
  }
  clipboard.writeText(text).catch(() => {});
  return true;
};

const isCopyShortcut = (event: KeyboardEvent): boolean => {
  if (event.type !== "keydown") {
    return false;
  }
  if (!(event.key === "c" || event.key === "C")) {
    return false;
  }
  // Cmd+C (mac) or Ctrl+Shift+C (win/linux). Plain Ctrl+C is intentionally left
  // alone so it still sends SIGINT (\x03) to the foreground process.
  return Boolean(event.metaKey) || Boolean(event.ctrlKey && event.shiftKey);
};

/**
 * Handler for xterm.attachCustomKeyEventHandler. On the terminal copy shortcut,
 * copies the current selection and returns false so xterm does not forward the
 * key to the PTY. Returns true for every other key (xterm processes normally).
 */
export const createCopyKeyHandler =
  (terminal: SelectableTerminal, clipboard: ClipboardLike | undefined | null) =>
  (event: KeyboardEvent): boolean => {
    if (isCopyShortcut(event) && terminal.hasSelection()) {
      copySelectionToClipboard(terminal, clipboard);
      return false;
    }
    return true;
  };
