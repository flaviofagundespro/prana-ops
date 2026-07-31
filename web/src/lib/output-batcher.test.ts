/**
 * OutputBatcher tests (AC4, AC10): bursty appends coalesce into ONE flush per
 * window, with no data loss and no reordering. Driven entirely by
 * `vi.useFakeTimers()` — no real time, no flakiness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutputBatcher } from './output-batcher.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('OutputBatcher', () => {
  it('coalesces a burst of appends into a single flush', () => {
    const flush = vi.fn();
    const b = new OutputBatcher({ flush, delayMs: 16 });

    b.append('a');
    b.append('b');
    b.append('c');

    // Nothing flushed before the window elapses.
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('abc');
  });

  it('preserves order across chunks (no reordering)', () => {
    const flush = vi.fn();
    const b = new OutputBatcher({ flush, delayMs: 20 });

    b.append('first ');
    b.append('second ');
    b.append('third');
    vi.advanceTimersByTime(20);

    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('first second third');
  });

  it('loses no data across multiple windows', () => {
    const flush = vi.fn();
    const b = new OutputBatcher({ flush, delayMs: 16 });

    b.append('window1a');
    b.append('window1b');
    vi.advanceTimersByTime(16); // flush 1

    b.append('window2a');
    b.append('window2b');
    vi.advanceTimersByTime(16); // flush 2

    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush.mock.calls[0][0]).toBe('window1awindow1b');
    expect(flush.mock.calls[1][0]).toBe('window2awindow2b');
  });

  it('never flushes an empty buffer', () => {
    const flush = vi.fn();
    const b = new OutputBatcher({ flush, delayMs: 16 });

    // No appends; advancing time must not flush.
    vi.advanceTimersByTime(100);
    expect(flush).not.toHaveBeenCalled();

    // Explicit flush() with empty buffer is also a no-op.
    b.flush();
    expect(flush).not.toHaveBeenCalled();
  });

  it('produces at most one flush per burst regardless of burst size', () => {
    const flush = vi.fn();
    const b = new OutputBatcher({ flush, delayMs: 16 });

    for (let i = 0; i < 500; i++) b.append('x');
    vi.advanceTimersByTime(16);

    expect(flush).toHaveBeenCalledTimes(1);
    expect((flush.mock.calls[0][0] as string).length).toBe(500);
  });

  it('dispose drops buffered data and cancels the pending flush', () => {
    const flush = vi.fn();
    const b = new OutputBatcher({ flush, delayMs: 16 });

    b.append('pending');
    b.dispose();
    vi.advanceTimersByTime(100);

    expect(flush).not.toHaveBeenCalled();
  });
});
