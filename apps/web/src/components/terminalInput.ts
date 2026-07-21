// biome-ignore lint/suspicious/noControlCharactersInRegex: xterm mouse reports use the ESC control character.
const TERMINAL_MOUSE_REPORT_PATTERN = /\x1b\[M[\x20-\xff]{3}|\x1b\[<(\d+);\d+;\d+[Mm]/g;

// SGR wheel button codes are 64-67, optionally OR-ed with the shift(4)/meta(8)/ctrl(16)
// modifier bits. Wheel reports must reach the PTY: alternate-screen apps (claude) have no
// xterm scrollback, so their own transcript scroll — driven by these reports — is the only
// way to scroll. Click/motion/release reports stay stripped (they paste garbage into shells
// left in a stale mouse-tracking mode).
const SGR_MODIFIER_BITS = 28;

const isWheelButtonCode = (code: number): boolean => {
  const base = code & ~SGR_MODIFIER_BITS;
  return base >= 64 && base <= 67;
};

export const stripTerminalMouseReports = (data: string): string =>
  data.replace(TERMINAL_MOUSE_REPORT_PATTERN, (match, sgrButtonCode?: string) => {
    if (sgrButtonCode !== undefined && isWheelButtonCode(Number.parseInt(sgrButtonCode, 10))) {
      return match;
    }
    return "";
  });
