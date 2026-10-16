import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { format } from 'node:util';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 512;

export function createRateLimitedLogger(target, {
  intervalMs = DEFAULT_INTERVAL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = performance.now.bind(performance),
} = {}) {
  const entryLimit = Number.isInteger(maxEntries) && maxEntries > 0
    ? maxEntries
    : DEFAULT_MAX_ENTRIES;
  const interval = Number.isFinite(intervalMs) && intervalMs >= 0
    ? intervalMs
    : DEFAULT_INTERVAL_MS;
  const state = new Map();
  const methods = ['debug', 'info', 'log', 'warn', 'error'];
  const wrapped = {};
  const writers = new Map();
  let lastTimestamp = Number.NEGATIVE_INFINITY;

  for (const method of methods) {
    if (typeof target[method] !== 'function') continue;
    const write = target[method].bind(target);
    writers.set(method, write);
    wrapped[method] = (...args) => {
      const message = format(...args);
      const key = createHash('sha256').update(`${method}\0${message}`).digest('hex');
      const observedTimestamp = now();
      const timestamp = Number.isFinite(observedTimestamp)
        ? Math.max(lastTimestamp, observedTimestamp)
        : lastTimestamp === Number.NEGATIVE_INFINITY ? 0 : lastTimestamp;
      lastTimestamp = timestamp;
      const entry = state.get(key);

      if (!entry) {
        if (state.size >= entryLimit) {
          const oldestKey = state.keys().next().value;
          const oldestEntry = state.get(oldestKey);
          if (oldestEntry.suppressed > 0) {
            writers.get(oldestEntry.method)(`[log-limit] suppressed ${oldestEntry.suppressed} duplicate ${oldestEntry.method} log line(s) before cache eviction`);
          }
          state.delete(oldestKey);
        }
        state.set(key, { lastEmittedAt: timestamp, suppressed: 0, method });
        write(...args);
        return;
      }

      if (timestamp - entry.lastEmittedAt < interval) {
        entry.suppressed += 1;
        return;
      }

      if (entry.suppressed > 0) {
        write(`[log-limit] suppressed ${entry.suppressed} duplicate ${method} log line(s)`);
      }
      entry.lastEmittedAt = timestamp;
      entry.suppressed = 0;
      write(...args);
    };
  }

  return wrapped;
}
