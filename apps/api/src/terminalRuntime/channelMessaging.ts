import { logVerbose } from "../logging";
import type { ChannelMessage, PersistedTerminal, TerminalSession } from "./types";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export const createChannelMessaging = (deps: {
  terminals: Map<string, PersistedTerminal>;
  sessions: Map<string, TerminalSession>;
  writeInput: (terminalId: string, data: string) => boolean;
}) => {
  const { terminals, sessions, writeInput } = deps;
  const channelQueues = new Map<string, ChannelMessage[]>();
  let channelMessageCounter = 0;

  const deliverChannelMessages = (terminalId: string): void => {
    const queue = channelQueues.get(terminalId);
    if (!queue || queue.length === 0) {
      return;
    }

    const session = sessions.get(terminalId);
    if (!session) {
      return;
    }

    const undelivered = queue.filter((m) => !m.delivered);
    if (undelivered.length === 0) {
      return;
    }

    // Compose all pending messages into a single prompt injection.
    // Prefer tentacle name over terminal ID for human-readable attribution;
    // fall back to terminal ID only if the sender is not registered.
    const lines = undelivered.map((m) => {
      const fromTerminal = terminals.get(m.fromTerminalId);
      const displayName = fromTerminal?.tentacleName ?? m.fromTerminalId;
      return `[Channel message from ${displayName}]: ${m.content}`;
    });
    // Wrap with bracketed paste markers so Claude Code receives the message
    // atomically. Without these, multi-line content reaches the PTY as a
    // keystroke stream and Windows ConPTY can drop bytes on input-queue
    // overflow — the trailing \r then submits whatever fragment landed,
    // surfacing as truncated drafts. Mirrors the initialPrompt path in
    // sessionRuntime.ts which already wraps for the same reason.
    const prompt = `${BRACKETED_PASTE_START}${lines.join("\n")}${BRACKETED_PASTE_END}\r`;

    logVerbose(`[Channel] Delivering ${undelivered.length} message(s) to ${terminalId}`);

    for (const m of undelivered) {
      m.delivered = true;
    }

    writeInput(terminalId, prompt);
  };

  return {
    sendChannelMessage(
      toTerminalId: string,
      fromTerminalId: string,
      content: string,
    ): ChannelMessage | null {
      if (!terminals.has(toTerminalId)) {
        return null;
      }

      channelMessageCounter += 1;
      const message: ChannelMessage = {
        messageId: `msg-${channelMessageCounter}`,
        fromTerminalId,
        toTerminalId,
        content,
        timestamp: new Date().toISOString(),
        delivered: false,
      };

      const queue = channelQueues.get(toTerminalId) ?? [];
      queue.push(message);
      channelQueues.set(toTerminalId, queue);

      logVerbose(
        `[Channel] Queued message ${message.messageId} from=${fromTerminalId} to=${toTerminalId}`,
      );

      // If the target session is idle, deliver immediately.
      const targetSession = sessions.get(toTerminalId);
      if (targetSession && targetSession.agentState === "idle") {
        deliverChannelMessages(toTerminalId);
      }

      return message;
    },

    listChannelMessages(
      terminalId: string,
    ): Array<ChannelMessage & { fromTerminalName?: string }> {
      const raw = channelQueues.get(terminalId) ?? [];
      return raw.map((m) => {
        const fromTerminal = terminals.get(m.fromTerminalId);
        return fromTerminal?.tentacleName
          ? { ...m, fromTerminalName: fromTerminal.tentacleName }
          : m;
      });
    },

    deliverChannelMessages,
  };
};
