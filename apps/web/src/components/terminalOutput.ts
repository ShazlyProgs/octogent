// Windows ConPTY interleaves ESC[3J (erase saved lines) into its attach and
// resize repaints; xterm honors it and wipes the scrollback the user still
// needs, leaving nothing to scroll. Strip ONLY the scrollback-erase sequence
// and keep every other control sequence intact. History replays operate on the
// joined chunk string, so sequences split across live chunk boundaries heal on
// the next replay.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the scrollback-erase sequence starts with the ESC control character.
const SCROLLBACK_ERASE_PATTERN = /\x1b\[3J/g;

export const stripScrollbackErase = (data: string): string =>
  data.replace(SCROLLBACK_ERASE_PATTERN, "");
