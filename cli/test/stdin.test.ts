import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

/**
 * readStdin binds directly to process.stdin, so we swap it with a fake
 * EventEmitter before each test.  We dynamically import the module after
 * patching so the fresh import picks up the fake stdin.
 */

let originalStdin: typeof process.stdin;

function createFakeStdin(): EventEmitter & { setEncoding: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  emitter.setEncoding = vi.fn();
  emitter.destroy = vi.fn();
  return emitter;
}

beforeEach(() => {
  originalStdin = process.stdin;
  vi.useFakeTimers();
});

afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadReadStdin(): Promise<typeof import('../src/stdin')['readStdin']> {
  const mod = await import('../src/stdin');
  return mod.readStdin;
}

describe('readStdin', () => {
  it('reads valid JSON from stdin', async () => {
    const fake = createFakeStdin();
    Object.defineProperty(process, 'stdin', { value: fake, writable: true });

    const readStdin = await loadReadStdin();
    const promise = readStdin();

    const payload = JSON.stringify({ key: 'value', nested: { n: 1 } });
    fake.emit('data', payload);
    fake.emit('end');

    const result = await promise;
    const parsed: Record<string, unknown> = JSON.parse(result);
    expect(parsed).toEqual({ key: 'value', nested: { n: 1 } });
  });

  it('accumulates multiple data chunks before end', async () => {
    const fake = createFakeStdin();
    Object.defineProperty(process, 'stdin', { value: fake, writable: true });

    const readStdin = await loadReadStdin();
    const promise = readStdin();

    fake.emit('data', '{"a":');
    fake.emit('data', '"b"}');
    fake.emit('end');

    const result = await promise;
    const parsed: Record<string, unknown> = JSON.parse(result);
    expect(parsed).toEqual({ a: 'b' });
  });

  it('resolves with accumulated data when timeout fires', async () => {
    const fake = createFakeStdin();
    Object.defineProperty(process, 'stdin', { value: fake, writable: true });

    const readStdin = await loadReadStdin();
    const promise = readStdin(50);

    fake.emit('data', 'partial');
    // Do not emit 'end' -- let the timeout trigger resolution.
    vi.advanceTimersByTime(50);

    const result = await promise;
    expect(result).toBe('partial');
    expect(fake.destroy).toHaveBeenCalled();
  });

  it('uses the default 10 s timeout when none is provided', async () => {
    const fake = createFakeStdin();
    Object.defineProperty(process, 'stdin', { value: fake, writable: true });

    const readStdin = await loadReadStdin();
    const promise = readStdin();

    // Advance to just under 10 s -- should not yet resolve.
    vi.advanceTimersByTime(9_999);
    // Promise should still be pending (no end emitted, timer hasn't fired).
    let resolved = false;
    void promise.then(() => { resolved = true; });
    // Flush the microtask queue so the .then callback would fire if it could.
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    // Now cross the 10 s boundary.
    vi.advanceTimersByTime(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
  });

  it('resolves with empty string when stdin is empty and ends immediately', async () => {
    const fake = createFakeStdin();
    Object.defineProperty(process, 'stdin', { value: fake, writable: true });

    const readStdin = await loadReadStdin();
    const promise = readStdin();

    fake.emit('end');

    const result = await promise;
    expect(result).toBe('');
  });

  it('resolves with empty string on stdin error', async () => {
    const fake = createFakeStdin();
    Object.defineProperty(process, 'stdin', { value: fake, writable: true });

    const readStdin = await loadReadStdin();
    const promise = readStdin();

    fake.emit('error', new Error('read ECONNRESET'));

    const result = await promise;
    expect(result).toBe('');
  });

  it('returns raw string that is not valid JSON (caller decides parsing)', async () => {
    const fake = createFakeStdin();
    Object.defineProperty(process, 'stdin', { value: fake, writable: true });

    const readStdin = await loadReadStdin();
    const promise = readStdin();

    fake.emit('data', 'not json {{{');
    fake.emit('end');

    const result = await promise;
    expect(result).toBe('not json {{{');
    expect(() => JSON.parse(result)).toThrow();
  });

  it('resolves with empty string when timeout fires and no data was received', async () => {
    const fake = createFakeStdin();
    Object.defineProperty(process, 'stdin', { value: fake, writable: true });

    const readStdin = await loadReadStdin();
    const promise = readStdin(20);

    // No data, no end -- just let the timeout fire.
    vi.advanceTimersByTime(20);

    const result = await promise;
    expect(result).toBe('');
    expect(fake.destroy).toHaveBeenCalled();
  });
});
