/**
 * Minimal typed publish/subscribe event bus.
 *
 * Topics are plain strings; handlers are typed per-topic through the
 * {@link EventMap} generic so that `emit` payloads are checked against the
 * subscribed event names.
 */

/** Any record mapping topic names to their payload types. */
export type EventMap = Record<string, unknown>;

/** Callback invoked with the payload emitted on a topic. */
export type EventHandler<T> = (payload: T) => void;

/** Function returned by {@link EventBus.on} that removes the subscription. */
export type Unsubscribe = () => void;

/** Alias kept for readability at call sites. */
export type EventBusTopics = EventMap;

/**
 * In-memory event bus. `M` describes the known topics; an index signature on
 * `M` allows arbitrary string topics when the consumer does not declare them.
 */
export class EventBus<M extends EventMap = EventMap> {
  // Keyed by plain string; typed access is enforced at the method boundary.
  readonly #handlers = new Map<string, Set<EventHandler<unknown>>>();

  /** Subscribe to a topic. Returns an unsubscribe function. */
  on<K extends keyof M & string>(topic: K, handler: EventHandler<M[K]>): Unsubscribe {
    let set = this.#handlers.get(topic);
    if (!set) {
      set = new Set();
      this.#handlers.set(topic, set);
    }
    set.add(handler as EventHandler<unknown>);
    return () => this.off(topic, handler);
  }

  /** Subscribe to the next emission of a topic only, then auto-unsubscribe. */
  once<K extends keyof M & string>(topic: K, handler: EventHandler<M[K]>): Unsubscribe {
    const unsubscribe = this.on(topic, (payload) => {
      unsubscribe();
      handler(payload);
    });
    return unsubscribe;
  }

  /** Remove a previously registered handler. */
  off<K extends keyof M & string>(topic: K, handler: EventHandler<M[K]>): void {
    const set = this.#handlers.get(topic);
    if (!set) return;
    set.delete(handler as EventHandler<unknown>);
    if (set.size === 0) this.#handlers.delete(topic);
  }

  /**
   * Publish a payload to all handlers of a topic.
   * Handler errors are isolated so one failing subscriber cannot break others.
   */
  emit<K extends keyof M & string>(topic: K, payload: M[K]): void {
    const set = this.#handlers.get(topic);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[event-bus] handler for "${topic}" threw:`, error);
      }
    }
  }

  /** Remove every subscription for a topic, or all topics when omitted. */
  clear(topic?: keyof M & string): void {
    if (topic === undefined) {
      this.#handlers.clear();
      return;
    }
    this.#handlers.delete(topic);
  }
}
