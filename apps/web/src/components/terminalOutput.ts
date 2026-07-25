// Windows ConPTY interleaves ESC[3J (erase saved lines) into its attach and
// resize repaints; xterm honors it and wipes the scrollback the user still
// needs, leaving nothing to scroll. Strip ONLY the scrollback-erase sequence
// and keep every other control sequence intact.
//
// The pure `stripScrollbackErase` below is a one-shot regex for a single joined
// string (history replays join their chunks, so it still suffices there). The
// streaming output path instead uses `createTerminalSanitizer()`: a per-terminal
// stateful scanner that carries escape-sequence state across chunk boundaries,
// so a ESC[3J split between two PTY/WebSocket messages is still stripped and an
// OSC title sequence split from its BEL terminator is still swallowed whole.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the scrollback-erase sequence starts with the ESC control character.
const SCROLLBACK_ERASE_PATTERN = /\x1b\[3J/g;

export const stripScrollbackErase = (data: string): string =>
  data.replace(SCROLLBACK_ERASE_PATTERN, "");

const ESC_CODE = 0x1b;
const BEL_CODE = 0x07;
const ESC = String.fromCharCode(ESC_CODE);
// Only the public scrollback-erase sequence is stripped; private-mode variants
// (e.g. ESC[?3J) pass through unchanged.
const SCROLLBACK_ERASE_CSI = `${ESC}[3J`;

// Scanner states for the streaming sanitizer. Numbers (not a const enum) so the
// module stays compatible with isolatedModules/esbuild transpilation.
const STATE_GROUND = 0; // emitting text normally
const STATE_ESCAPE = 1; // saw ESC, waiting on the sequence introducer
const STATE_CSI = 2; // inside ESC [ ... ; collecting params until the final byte
const STATE_OSC = 3; // inside ESC ] ... ; swallowing payload until BEL or ST (ESC \)
const STATE_OSC_ESCAPE = 4; // inside OSC, saw ESC, expecting \ for ST

export type TerminalSanitizer = {
  /**
   * Strip ESC[3J and swallow OSC title sequences (ESC ] … BEL / ESC \) from one
   * chunk of terminal output, carrying any partially-received escape sequence
   * across to the next call. Safe to call once per WebSocket/PTY message; a
   * sequence split between two messages still resolves correctly.
   */
  sanitize: (chunk: string) => string;
  /**
   * Emit any bytes held back because they began a (still incomplete) ESC/CSI
   * sequence, then reset to Ground. Call at flush/teardown so a dangling partial
   * escape is written through as literal text instead of being silently dropped.
   * Returns "" when nothing was held. An unterminated OSC is NOT resurrected: its
   * introducer was swallowed on entry, so emitting half a title string would be
   * worse than dropping it.
   */
  flush: () => string;
};

export const createTerminalSanitizer = (): TerminalSanitizer => {
  let state = STATE_GROUND;
  // Bytes of the in-progress ESC/CSI sequence that have not yet resolved. Held
  // (not emitted) across sanitize() calls until the sequence completes — that
  // hold-back is what makes a boundary-split ESC[3J vanish. OSC payload is
  // swallowed on the fly and never lands here.
  let buffer = "";

  return {
    sanitize(chunk: string) {
      const segments: string[] = [];
      // Start of the current run of ground text within this chunk. Slicing runs
      // (rather than concatenating char-by-char) keeps this O(n) for the large
      // single strings history replays feed in.
      let runStart = 0;
      const emitRun = (end: number) => {
        if (end > runStart) {
          segments.push(chunk.slice(runStart, end));
        }
      };

      for (let i = 0; i < chunk.length; i++) {
        const code = chunk.charCodeAt(i);
        const char = chunk.charAt(i);

        switch (state) {
          case STATE_GROUND: {
            if (code === ESC_CODE) {
              emitRun(i);
              state = STATE_ESCAPE;
              buffer = ESC;
            }
            break; // otherwise stay in the ground run; advance below
          }
          case STATE_ESCAPE: {
            buffer += char;
            if (char === "[") {
              state = STATE_CSI;
            } else if (char === "]") {
              // OSC introducer: drop the buffered ESC] and swallow the payload.
              state = STATE_OSC;
              buffer = "";
            } else {
              // Two-byte escape (RIS, index, keypad mode, ...): pass it through.
              segments.push(buffer);
              buffer = "";
              state = STATE_GROUND;
              runStart = i + 1;
            }
            break;
          }
          case STATE_CSI: {
            buffer += char;
            // Final byte range 0x40–0x7E terminates a CSI sequence.
            if (code >= 0x40 && code <= 0x7e) {
              if (buffer !== SCROLLBACK_ERASE_CSI) {
                segments.push(buffer); // not the scrollback erase: pass through
              }
              buffer = "";
              state = STATE_GROUND;
              runStart = i + 1;
            }
            break;
          }
          case STATE_OSC: {
            if (code === BEL_CODE) {
              state = STATE_GROUND;
              runStart = i + 1;
            } else if (code === ESC_CODE) {
              state = STATE_OSC_ESCAPE;
            }
            break; // any other byte is OSC payload — swallow it
          }
          case STATE_OSC_ESCAPE: {
            if (char === "\\") {
              state = STATE_GROUND; // ST (ESC \) terminator
              runStart = i + 1;
            } else if (code === BEL_CODE) {
              state = STATE_GROUND; // BEL also terminates OSC
              runStart = i + 1;
            } else if (code !== ESC_CODE) {
              // ESC followed by something other than \ inside an OSC: treat the
              // run as ongoing OSC payload and keep swallowing.
              state = STATE_OSC;
            }
            break; // a further ESC keeps waiting for the ST backslash
          }
        }
      }

      if (state === STATE_GROUND) {
        emitRun(chunk.length);
      }
      return segments.join("");
    },

    flush() {
      let out = "";
      if (state === STATE_ESCAPE || state === STATE_CSI) {
        // A partial ESC/CSI never completed — write it through as literal text
        // rather than dropping it (the drainable-flush contract from
        // terminalFlush.ts: never silently lose tail bytes).
        out = buffer;
        buffer = "";
      }
      state = STATE_GROUND;
      return out;
    },
  };
};
