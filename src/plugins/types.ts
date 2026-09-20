import type { EventBus } from '../core/event-bus.js';
import type { SessionManager } from '../core/session-manager.js';
import type { JsonStore } from '../core/storage.js';
import type { Message } from '../core/types.js';
import type { LLMProvider } from '../llm/types.js';
import type { Scheduler } from '../scheduler/scheduler.js';

/**
 * Capabilities handed to a plugin at init time. A plugin receives the kernel's
 * shared services rather than constructing its own.
 */
export interface PluginContext {
  /** Kernel event bus for pub/sub. */
  eventBus: EventBus;
  /** Session store. */
  sessions: SessionManager;
  /** Interval scheduler for recurring plugin work. */
  scheduler: Scheduler;
  /** Configured LLM provider. */
  llm: LLMProvider;
  /** JSON-backed store for plugin-owned persistence (see `storage.dataDir`). */
  storage: JsonStore;
  /**
   * Plugin configurations from the runtime config, keyed by plugin name
   * (e.g. `config.proactiveChat`). Read and validate your own slice defensively.
   */
  config: Record<string, unknown>;
  /**
   * Send an outbound agent message to a session.
   * Appends an `agent`-role message and emits `message:outbound`.
   */
  send(sessionId: string, content: string): Promise<Message>;
}

/**
 * A KAIROS plugin. Plugins may only be initialized after the kernel has
 * started the shared services.
 */
export interface Plugin {
  /** Unique plugin name. */
  name: string;
  /** Semver version string. */
  version: string;
  /** Called once during runtime start. May be async. */
  init(ctx: PluginContext): void | Promise<void>;
  /** Called once during runtime stop, in reverse registration order. */
  teardown?(): void | Promise<void>;
}
