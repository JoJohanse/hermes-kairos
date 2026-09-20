/**
 * Core domain types for the KAIROS kernel.
 */

/** Conversation role. `agent` denotes outbound messages produced by the runtime. */
export type MessageRole = 'user' | 'agent' | 'system';

/** A single message within a session. */
export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  timestamp: number;
}

/** A conversation session with its ordered message history. */
export interface Session {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  messages: Message[];
  metadata: Record<string, unknown>;
}
