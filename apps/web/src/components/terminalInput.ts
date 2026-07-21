// biome-ignore lint/suspicious/noControlCharactersInRegex: xterm mouse reports use the ESC control character.
const TERMINAL_MOUSE_REPORT_PATTERN = /\x1b\[M[\x20-\xff]{3}|\x1b\[<\d+;\d+;\d+[Mm]/g;

export const stripTerminalMouseReports = (data: string): string =>
  data.replace(TERMINAL_MOUSE_REPORT_PATTERN, "");
