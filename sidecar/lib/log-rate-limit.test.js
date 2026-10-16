import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'node:util';
import { createRateLimitedLogger } from './log-rate-limit.js';

describe('createRateLimitedLogger', () => {
  it('suppresses exact duplicate lines and reports the suppressed count', () => {
    let timestamp = 1000;
    const output = [];
    const logger = createRateLimitedLogger({
      info: (...args) => output.push(format(...args)),
    }, { intervalMs: 100, now: () => timestamp });

    logger.info('request %d failed', 1);
    logger.info('request %d failed', 1);
    logger.info('request %d failed', 1);
    assert.deepEqual(output, ['request 1 failed']);

    timestamp += 100;
    logger.info('request %d failed', 1);
    assert.deepEqual(output, [
      'request 1 failed',
      '[log-limit] suppressed 2 duplicate info log line(s)',
      'request 1 failed',
    ]);
  });

  it('keeps different messages and levels independent', () => {
    const output = [];
    const logger = createRateLimitedLogger({
      info: message => output.push(`info:${message}`),
      error: message => output.push(`error:${message}`),
    }, { now: () => 1000 });

    logger.info('same');
    logger.error('same');
    logger.info('different');
    assert.deepEqual(output, ['info:same', 'error:same', 'info:different']);
  });

  it('bounds deduplication state and reports suppressed lines before eviction', () => {
    const output = [];
    const logger = createRateLimitedLogger({ log: message => output.push(message) }, {
      maxEntries: 2,
      now: () => 1000,
    });

    logger.log('a');
    logger.log('a');
    logger.log('b');
    logger.log('c');
    logger.log('a');
    assert.deepEqual(output, [
      'a',
      'b',
      '[log-limit] suppressed 1 duplicate log log line(s) before cache eviction',
      'c',
      'a',
    ]);
  });

  it('reports evicted duplicates through their original log level', () => {
    const output = [];
    const logger = createRateLimitedLogger({
      error: message => output.push(`error:${message}`),
      info: message => output.push(`info:${message}`),
    }, { maxEntries: 1, now: () => 1000 });

    logger.error('failure');
    logger.error('failure');
    logger.info('ready');
    assert.deepEqual(output, [
      'error:failure',
      'error:[log-limit] suppressed 1 duplicate error log line(s) before cache eviction',
      'info:ready',
    ]);
  });

  it('falls back to safe defaults for invalid bounds', () => {
    const output = [];
    const logger = createRateLimitedLogger({ log: message => output.push(message) }, {
      maxEntries: 0,
      intervalMs: -1,
      now: () => 1000,
    });

    logger.log('one');
    logger.log('two');
    assert.deepEqual(output, ['one', 'two']);
  });

  it('uses a nondecreasing clock when the injected wall clock moves backwards', () => {
    let timestamp = 1000;
    const output = [];
    const logger = createRateLimitedLogger({ log: message => output.push(message) }, {
      intervalMs: 100,
      now: () => timestamp,
    });

    logger.log('same');
    timestamp = 900;
    logger.log('same');
    timestamp = 1099;
    logger.log('same');
    assert.deepEqual(output, ['same']);

    timestamp = 1100;
    logger.log('same');
    assert.deepEqual(output, [
      'same',
      '[log-limit] suppressed 2 duplicate log log line(s)',
      'same',
    ]);
  });
});
