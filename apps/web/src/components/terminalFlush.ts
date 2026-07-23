// Coalesces terminal output into one terminal.write per animation frame.
//
// claude streams its TUI token-by-token and repaints markdown in bursts; the API
// broadcasts every PTY chunk and the client used to call terminal.write once per
// message (JSON.parse + strip + write scheduling each time). Under a burst that
// floods the main thread and the UI freezes / writing falls behind. This helper
// buffers incoming chunks and flushes them as a single joined terminal.write on
// the next requestAnimationFrame — order preserved, ≤1 frame of added latency,
// and per-message overhead collapsed to ~1 write/frame no matter how large the
// flood.
//
// requestAnimationFrame/cancelAnimationFrame are injected (not imported) so the
// batching logic is unit-testable without touching the global rAF queue.

type WritableTerminal = {
  write: (data: string, callback?: () => void) => void;
};

export type TerminalWriteCoalescer = {
  /** Queue a chunk for the next frame. No-op after dispose(). */
  enqueue: (data: string) => void;
  /** Cancel any pending frame and drop buffered chunks. Safe to call once. */
  dispose: () => void;
};

export const createTerminalWriteCoalescer = (
  terminal: WritableTerminal,
  schedule: (callback: FrameRequestCallback) => number,
  cancel: (handle: number) => void,
): TerminalWriteCoalescer => {
  let pending: string[] = [];
  let frameHandle: number | null = null;
  let disposed = false;

  const flush = () => {
    frameHandle = null;
    if (pending.length === 0) {
      return;
    }
    const joined = pending.join("");
    pending = [];
    terminal.write(joined);
  };

  return {
    enqueue(data: string) {
      if (disposed) {
        return;
      }
      pending.push(data);
      // A frame is already scheduled — every chunk queued this frame rides it.
      if (frameHandle === null) {
        frameHandle = schedule(flush);
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (frameHandle !== null) {
        cancel(frameHandle);
        frameHandle = null;
      }
      pending = [];
    },
  };
};
