import type { Plugin, PluginContext } from '../../plugins/types.js';

/** Plugin name used for config lookup and registry identity. */
export const PROACTIVE_CHAT_PLUGIN_NAME = 'proactive-chat';

/** Plugin version. */
export const PROACTIVE_CHAT_PLUGIN_VERSION = '0.1.0';

/**
 * Placeholder for the proactive-conversation plugin.
 *
 * The kernel scaffold only wires the plugin into the lifecycle: `init()` logs
 * registration and captures the context. The decision loop that actually
 * initiates conversations is intentionally unimplemented — see `README.md` in
 * this directory for the open design questions the orchestrator must resolve.
 */
export class ProactiveChatPlugin implements Plugin {
  readonly name = PROACTIVE_CHAT_PLUGIN_NAME;
  readonly version = PROACTIVE_CHAT_PLUGIN_VERSION;

  #ctx: PluginContext | undefined;

  /** PluginContext captured at init; `undefined` before init / after teardown. */
  get context(): PluginContext | undefined {
    return this.#ctx;
  }

  init(ctx: PluginContext): void {
    this.#ctx = ctx;
    // TODO(orchestrator): read the `proactiveChat` config slice, register the
    // evaluation task on `ctx.scheduler`, and implement the decision gate.
    console.log(`[plugin] registered ${this.name}@${this.version}`);
  }

  teardown(): void {
    // TODO(orchestrator): cancel any scheduled tasks registered at init.
    this.#ctx = undefined;
    console.log(`[plugin] stopped ${this.name}@${this.version}`);
  }
}

/** Factory used by the runtime bootstrap. */
export function createProactiveChatPlugin(): Plugin {
  return new ProactiveChatPlugin();
}
