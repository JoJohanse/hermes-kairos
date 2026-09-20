import type { Plugin, PluginContext } from './types.js';

/** A plugin that failed during initialization. */
export interface PluginInitError {
  plugin: string;
  error: unknown;
}

/** A plugin that failed during teardown. */
export interface PluginTeardownError {
  plugin: string;
  error: unknown;
}

/** Options for {@link PluginRegistry}. */
export interface PluginRegistryOptions {
  /** Invoked whenever a plugin fails to init or teardown (after logging). */
  onError?: (info: PluginInitError) => void;
}

/**
 * Ordered registry of plugins.
 *
 * Initialization is failure-isolated: one plugin throwing does not prevent the
 * remaining plugins from initializing. Teardown runs in reverse order.
 */
export class PluginRegistry {
  readonly #plugins = new Map<string, Plugin>();
  readonly #initialized: string[] = [];
  readonly #onError: ((info: PluginInitError) => void) | undefined;

  constructor(options: PluginRegistryOptions = {}) {
    this.#onError = options.onError;
  }

  /** Register (or replace) a plugin by name. */
  register(plugin: Plugin): void {
    this.#plugins.set(plugin.name, plugin);
  }

  /** Retrieve a plugin by name. */
  get(name: string): Plugin | undefined {
    return this.#plugins.get(name);
  }

  /** List all registered plugins in registration order. */
  list(): Plugin[] {
    return [...this.#plugins.values()];
  }

  /** Names of plugins successfully initialized since the last teardown. */
  initialized(): string[] {
    return [...this.#initialized];
  }

  /**
   * Initialize every registered plugin sequentially.
   * Failures are collected and reported; they never abort the loop.
   */
  async initAll(ctx: PluginContext): Promise<PluginInitError[]> {
    const errors: PluginInitError[] = [];
    this.#initialized.length = 0;
    for (const plugin of this.#plugins.values()) {
      try {
        await plugin.init(ctx);
        this.#initialized.push(plugin.name);
      } catch (error) {
        errors.push({ plugin: plugin.name, error });
        console.error(`[plugins] init failed for "${plugin.name}":`, error);
        this.#onError?.({ plugin: plugin.name, error });
      }
    }
    return errors;
  }

  /**
   * Tear down initialized plugins in reverse order.
   * Failures are collected and reported; they never abort the loop.
   */
  async teardownAll(): Promise<PluginTeardownError[]> {
    const errors: PluginTeardownError[] = [];
    for (const name of [...this.#initialized].reverse()) {
      const plugin = this.#plugins.get(name);
      if (!plugin?.teardown) continue;
      try {
        await plugin.teardown();
      } catch (error) {
        errors.push({ plugin: name, error });
        console.error(`[plugins] teardown failed for "${name}":`, error);
      }
    }
    this.#initialized.length = 0;
    return errors;
  }
}
