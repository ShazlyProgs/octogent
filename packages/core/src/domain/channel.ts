export type ChannelMessage = {
  messageId: string;
  fromTerminalId: string;
  toTerminalId: string;
  content: string;
  timestamp: string;
  delivered: boolean;
  superseded?: { at: string; by: string; reason: string; custodyRef?: string };
  /** X2: unit key; a newer message with the same key supersedes older pending ones. */
  supersedeKey?: string;
  /** X2: undelivered past its TTL; dead-lettered, never auto-retyped. */
  expired?: { at: string; afterMs: number; held?: boolean };
  /** P33: written to the PTY but never reached the agent's log. delivered stays true for compatibility. */
  notSubmitted?: boolean;
  notSubmittedReason?: string;
  notSubmittedAt?: string;
  /** P33: when the text was written to the PTY. */
  deliveredAt?: string;
};
