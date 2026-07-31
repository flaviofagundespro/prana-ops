/**
 * Output batcher (AC4, Story 1.4).
 *
 * Coalesces bursty `channel:data` output into a single flush per interval so a
 * progress bar (many tiny writes) never floods xterm.js and freezes the UI. The
 * PRD fixes the WINDOW (~16–50ms); the MECHANISM is a documented @dev choice
 * (Article IV): a plain `setTimeout`-based scheduler, injectable so tests drive
 * it with `vi.useFakeTimers()` deterministically — no real-time flakiness.
 *
 * GUARANTEES:
 *  - No data loss: everything appended is flushed, in append order.
 *  - No reordering: chunks are concatenated in the exact order received.
 *  - At most one flush per window: N appends in one burst → ONE `flush(joined)`.
 *  - Trailing flush: appends after a flush start a fresh window.
 */

/** Injectable timer surface (defaults to global setTimeout/clearTimeout). */
export interface BatchScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultScheduler: BatchScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Default batching window (ms). Middle of the PRD's ~16–50ms range. */
export const DEFAULT_BATCH_MS = 16;

export interface OutputBatcherOptions {
  /** Called once per window with the concatenated buffer. */
  flush: (data: string) => void;
  /** Batching window in ms. Default {@link DEFAULT_BATCH_MS}. */
  delayMs?: number;
  /** Injectable scheduler (fake timers in tests). */
  scheduler?: BatchScheduler;
}

export class OutputBatcher {
  private readonly flushFn: (data: string) => void;
  private readonly delayMs: number;
  private readonly scheduler: BatchScheduler;
  private buffer = '';
  private timer: unknown = null;

  constructor(options: OutputBatcherOptions) {
    this.flushFn = options.flush;
    this.delayMs = options.delayMs ?? DEFAULT_BATCH_MS;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  /** Appends a chunk and arms the flush timer if not already armed. */
  append(chunk: string): void {
    this.buffer += chunk;
    if (this.timer === null) {
      this.timer = this.scheduler.set(() => this.flush(), this.delayMs);
    }
  }

  /** Flushes the buffer now (if non-empty) and disarms the timer. */
  flush(): void {
    if (this.timer !== null) {
      this.scheduler.clear(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const out = this.buffer;
    this.buffer = '';
    this.flushFn(out);
  }

  /** Disarms the timer and drops any buffered data (on unmount). */
  dispose(): void {
    if (this.timer !== null) {
      this.scheduler.clear(this.timer);
      this.timer = null;
    }
    this.buffer = '';
  }
}
