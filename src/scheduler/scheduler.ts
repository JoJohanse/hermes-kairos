/** A recurring task managed by the {@link Scheduler}. */
export interface ScheduledTask {
  /** Unique task name, used for cancellation. */
  name: string;
  /** Interval between runs in milliseconds. */
  intervalMs: number;
  /** Task body. May be async; overlapping runs are skipped. */
  run: () => void | Promise<void>;
}

/**
 * Minimal in-memory interval scheduler.
 *
 * Tasks run on `setInterval`; if a previous run of the same task is still in
 * flight when the next tick arrives, that tick is skipped.
 */
export class Scheduler {
  readonly #tasks = new Map<string, ScheduledTask>();
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>();
  readonly #running = new Set<string>();
  #started = false;

  /** Whether the scheduler is currently running. */
  get started(): boolean {
    return this.#started;
  }

  /** Register (or replace) a task. Starts its timer if the scheduler is running. */
  registerTask(task: ScheduledTask): void {
    if (task.intervalMs <= 0) {
      throw new Error(`Scheduler: intervalMs must be > 0 for task "${task.name}"`);
    }
    this.#tasks.set(task.name, task);
    if (this.#started) {
      this.#arm(task);
    }
  }

  /** Cancel a task and clear its timer. */
  cancelTask(name: string): boolean {
    const timer = this.#timers.get(name);
    if (timer !== undefined) {
      clearInterval(timer);
      this.#timers.delete(name);
    }
    this.#running.delete(name);
    return this.#tasks.delete(name);
  }

  /** Start timers for every registered task. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const task of this.#tasks.values()) {
      this.#arm(task);
    }
  }

  /** Stop all timers. Registered tasks are retained for a later `start()`. */
  stop(): void {
    for (const timer of this.#timers.values()) {
      clearInterval(timer);
    }
    this.#timers.clear();
    this.#running.clear();
    this.#started = false;
  }

  /** Names of currently registered tasks. */
  list(): string[] {
    return [...this.#tasks.keys()];
  }

  #arm(task: ScheduledTask): void {
    const existing = this.#timers.get(task.name);
    if (existing !== undefined) clearInterval(existing);
    const timer = setInterval(() => {
      void this.#invoke(task);
    }, task.intervalMs);
    // Do not keep the event loop alive solely for scheduled tasks.
    timer.unref?.();
    this.#timers.set(task.name, timer);
  }

  async #invoke(task: ScheduledTask): Promise<void> {
    if (this.#running.has(task.name)) return; // skip overlapping run
    this.#running.add(task.name);
    try {
      await task.run();
    } catch (error) {
      console.error(`[scheduler] task "${task.name}" threw:`, error);
    } finally {
      this.#running.delete(task.name);
    }
  }
}
