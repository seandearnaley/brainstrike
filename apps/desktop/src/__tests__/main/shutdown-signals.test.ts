import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installShutdownSignalHandlers } from '../../main/shutdown-signals';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function install() {
  const target = new EventEmitter();
  const onFirstSignal = vi.fn();
  const logger = { info: vi.fn() };
  installShutdownSignalHandlers({ logger, onFirstSignal, signals: SIGNALS, target });
  return { logger, onFirstSignal, target };
}

describe('installShutdownSignalHandlers', () => {
  it.each(SIGNALS)('installs one persistent %s listener that survives firing', (signal) => {
    const { onFirstSignal, target } = install();

    expect(target.listenerCount(signal)).toBe(1);
    target.emit(signal);

    // `once` would have removed it and restored the default action.
    expect(target.listenerCount(signal)).toBe(1);
    expect(onFirstSignal).toHaveBeenCalledTimes(1);
  });

  it.each(SIGNALS)('starts the shutdown from a first %s', (signal) => {
    const { logger, onFirstSignal, target } = install();

    target.emit(signal);

    expect(onFirstSignal).toHaveBeenCalledExactlyOnceWith(signal);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it.each([
    ['SIGINT', 'SIGINT'],
    ['SIGINT', 'SIGTERM'],
    ['SIGTERM', 'SIGHUP'],
    ['SIGHUP', 'SIGINT'],
  ] as const)('after a first %s, logs and ignores a later %s', (first, later) => {
    const { logger, onFirstSignal, target } = install();

    target.emit(first);
    target.emit(later);
    target.emit(later);

    expect(onFirstSignal).toHaveBeenCalledExactlyOnceWith(first);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenLastCalledWith('Shutdown already in progress; ignoring signal', {
      signal: later,
    });
  });

  it('replaces a listener a dependency registered earlier, so libuv arms a fresh watcher for ours', () => {
    const emitter = new EventEmitter();
    const dependencyListener = vi.fn();
    const order: string[] = [];
    emitter.once('SIGINT', dependencyListener);
    const target = {
      listenerCount: (signal: NodeJS.Signals) => emitter.listenerCount(signal),
      on: (signal: NodeJS.Signals, listener: () => void) => {
        order.push(`on:${signal}`);
        return emitter.on(signal, listener);
      },
      removeAllListeners: (signal: NodeJS.Signals) => {
        order.push(`removeAllListeners:${signal}`);
        return emitter.removeAllListeners(signal);
      },
    };
    const onFirstSignal = vi.fn();
    const logger = { info: vi.fn() };

    installShutdownSignalHandlers({ logger, onFirstSignal, signals: ['SIGINT'], target });
    emitter.emit('SIGINT');

    // Dropped BEFORE ours is added: a watcher is armed only when the first listener is added.
    expect(order).toEqual(['removeAllListeners:SIGINT', 'on:SIGINT']);
    expect(dependencyListener).not.toHaveBeenCalled();
    expect(onFirstSignal).toHaveBeenCalledExactlyOnceWith('SIGINT');
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      'Replaced existing signal listeners with the shutdown handler',
      { replaced: 1, signal: 'SIGINT' }
    );
  });

  it('touches only the signals it is given, and logs no replacement when nothing was registered', () => {
    const target = new EventEmitter();
    const otherListener = vi.fn();
    target.on('SIGUSR2', otherListener);
    const logger = { info: vi.fn() };

    installShutdownSignalHandlers({
      logger,
      onFirstSignal: vi.fn(),
      signals: ['SIGINT'],
      target,
    });
    target.emit('SIGUSR2');

    expect(otherListener).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('a later signal never force-quits: it neither calls the shutdown nor throws', () => {
    const { onFirstSignal, target } = install();
    target.emit('SIGINT');

    expect(() => {
      for (const signal of SIGNALS) {
        target.emit(signal);
      }
    }).not.toThrow();
    expect(onFirstSignal).toHaveBeenCalledTimes(1);
  });
});
