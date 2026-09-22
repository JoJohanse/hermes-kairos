import { DEFAULT_STORAGE_DATA_DIR } from '../config/config.js';
import type { EventMap } from '../core/event-bus.js';
import { EventBus } from '../core/event-bus.js';
import { SessionManager } from '../core/session-manager.js';
import { JsonStore } from '../core/storage.js';
import type { Message } from '../core/types.js';
import type { LLMProvider } from '../llm/types.js';
import { PluginRegistry } from '../plugins/registry.js';
import { Scheduler } from '../scheduler/scheduler.js';
import type { Plugin } from '../plugins/types.js';

/** Kernel-level events emitted by the runtime and its plugins. */
export interface KernelEvents extends EventMap {
  /** Emitted when a configuration object is supplied to the runtime. */
  'runtime:config': { config: RuntimeConfig };
  /** Emitted after `start()` finishes booting scheduler and plugins. */
  'runtime:started': Record<string, never>;
  /** Emitted after `stop()` finishes shutting everything down. */
  'runtime:stopped': Record<string, never>;
  /** Emitted for every appended message (any role) once it has been stored. */
  'message:appended': { message: Message };
  /** Emitted by the speak path (`runtime.send`, exposed to plugins as `PluginContext.send`) for every outbound agent message. */
  'message:outbound': { sessionId: string; content: string; timestamp: number };
  /** Emitted when plugin initialization fails. */
  'plugin:error': { plugin: string; error: unknown };
}

/** Minimal runtime configuration surface required by the kernel. */
export interface RuntimeConfig {
  llm: { baseURL: string; apiKey: string; model: string };
  /** Optional storage location for plugin JSON state. */
  storage?: { dataDir: string };
  plugins: Record<string, unknown>;
}

/** Dependencies injected into {@link HermesRuntime}. */
export interface HermesRuntimeOptions {
  config: RuntimeConfig;
  llm: LLMProvider;
  /** Optional event bus override (useful for tests). */
  eventBus?: EventBus<KernelEvents>;
  /** Optional scheduler override (useful for tests). */
  scheduler?: Scheduler;
}

/**
 * KAIROS kernel: owns the event bus, sessions, scheduler, LLM provider and
 * plugin registry, and coordinates their lifecycle.
 */
export class HermesRuntime {
  readonly eventBus: EventBus<KernelEvents>;
  readonly sessions: SessionManager;
  readonly scheduler: Scheduler;
  readonly llm: LLMProvider;
  readonly plugins: PluginRegistry;
  readonly storage: JsonStore;
  readonly config: RuntimeConfig;

  #started = false;
  #startedAt: number | null = null;

  constructor(options: HermesRuntimeOptions) {
    this.config = options.config;
    this.eventBus = options.eventBus ?? new EventBus<KernelEvents>();
    this.sessions = new SessionManager({ eventBus: this.eventBus });
    this.scheduler = options.scheduler ?? new Scheduler();
    this.storage = new JsonStore({
      dataDir: options.config.storage?.dataDir ?? DEFAULT_STORAGE_DATA_DIR,
    });
    this.llm = options.llm;
    this.plugins = new PluginRegistry({
      onError: ({ plugin, error }) => {
        this.eventBus.emit('plugin:error', { plugin, error });
      },
    });
  }

  /** Whether the runtime has been started and not yet stopped. */
  get started(): boolean {
    return this.#started;
  }

  /** Timestamp of the most recent `start()`, or `null`. */
  get startedAt(): number | null {
    return this.#startedAt;
  }

  /** Register a plugin with the runtime's registry. */
  register(plugin: Plugin): void {
    this.plugins.register(plugin);
  }

  /**
   * The speak path: append an agent message and emit `message:outbound` for it.
   * The one sanctioned way to speak as the agent — plugins receive it as
   * `PluginContext.send`, hosts (the bridge) call it directly, so the
   * append-then-outbound sequence has exactly one owner.
   */
  async send(sessionId: string, content: string): Promise<Message> {
    const message = this.sessions.appendMessage(sessionId, 'agent', content);
    this.eventBus.emit('message:outbound', {
      sessionId,
      content,
      timestamp: message.timestamp,
    });
    return message;
  }

  /**
   * Start the scheduler and initialize all registered plugins in order.
   * Plugin init failures are collected and logged, never fatal.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#startedAt = Date.now();
    this.eventBus.emit('runtime:config', { config: this.config });
    this.scheduler.start();
    await this.plugins.initAll({
      eventBus: this.eventBus,
      sessions: this.sessions,
      scheduler: this.scheduler,
      llm: this.llm,
      storage: this.storage,
      config: this.config.plugins,
      send: (sessionId, content) => this.send(sessionId, content),
    });
    this.eventBus.emit('runtime:started', {});
  }

  /** Tear down all plugins in reverse order and stop the scheduler. */
  async stop(): Promise<void> {
    if (!this.#started) return;
    await this.plugins.teardownAll();
    this.scheduler.stop();
    this.#started = false;
    this.#startedAt = null;
    this.eventBus.emit('runtime:stopped', {});
  }
}
