// Coalesces terminal output into one terminal.write per animation frame.
//
// claude and codex stream their TUIs token-by-token and repaint markdown in bursts; the API
// broadcasts every PTY chunk and the client used to call terminal.write once per message
// (JSON.parse + strip + write scheduling each time). Under a burst that floods the main thread
// and the UI freezes / writing falls behind. This helper buffers incoming chunks and flushes
// them as a single joined terminal.write — order preserved, <=1 frame of added latency, and
// per-message overhead collapsed to ~1 write/frame no matter how large the flood.
//
// The scheduling primitives (write / requestFlush / cancelFlush) are INJECTED rather than
// imported, so the batching logic is unit-testable without touching the global rAF queue and
// the caller owns the rAF-with-timer-fallback policy.
//
// flush() is deliberately public and returns the joined output: teardown must be able to DRAIN
// a pending burst synchronously (WebSocket close, history replay, unmount) instead of dropping
// it. The earlier dispose()-only shape discarded buffered chunks, which lost the tail of a
// session's output; the drain path is covered by terminalFlush.test.tsx.

type TerminalFlushHandle = number;

type TerminalWriteCoalescerOptions = {
  write: (output: string) => void;
  requestFlush: (flush: () => void) => TerminalFlushHandle;
  cancelFlush: (handle: TerminalFlushHandle) => void;
};

export type TerminalWriteCoalescer = {
  /** Queue a chunk for the next scheduled flush. Empty chunks are ignored. */
  push: (chunk: string) => void;
  /** Drain synchronously. Returns the joined output, or undefined when nothing was buffered. */
  flush: () => string | undefined;
};

export const createTerminalWriteCoalescer = ({
  write,
  requestFlush,
  cancelFlush,
}: TerminalWriteCoalescerOptions): TerminalWriteCoalescer => {
  let chunks: string[] = [];
  let flushHandle: TerminalFlushHandle | null = null;

  const flush = () => {
    if (flushHandle !== null) {
      cancelFlush(flushHandle);
      flushHandle = null;
    }
    if (chunks.length === 0) {
      return undefined;
    }

    const output = chunks.join("");
    chunks = [];
    write(output);
    return output;
  };

  return {
    push(chunk) {
      if (chunk.length === 0) {
        return;
      }

      chunks.push(chunk);
      if (flushHandle === null) {
        flushHandle = requestFlush(() => {
          flushHandle = null;
          flush();
        });
      }
    },
    flush,
  };
};
