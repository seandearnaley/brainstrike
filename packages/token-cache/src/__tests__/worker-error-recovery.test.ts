import { describe, expect, it } from 'vitest';
import {
  isRecoverableWorkerFailure,
  isTerminalTokenizerError,
  pruneRestartHistory,
  RECOVERABLE_WORKER_RESTART_WINDOW_MS,
} from '../worker-error-recovery';

describe('worker-error-recovery', () => {
  describe('isTerminalTokenizerError', () => {
    it.each([
      'accurate token counting unavailable: encoder missing',
      ' Error: TIKTOKEN encoder failed to initialize ',
      '  Error: Accurate token counting unavailable: encoder missing  ',
    ])('classifies terminal tokenizer failures: %s', (message) => {
      expect(isTerminalTokenizerError(message)).toBe(true);
    });

    it('does not classify an unrelated worker error as terminal', () => {
      expect(isTerminalTokenizerError('worker connection interrupted')).toBe(false);
    });
  });

  describe('isRecoverableWorkerFailure', () => {
    it.each([
      'ready-timeout',
      'worker.onerror',
      'worker.addEventListener(error)',
      'worker.onmessageerror',
    ])('classifies %s as recoverable', (context) => {
      expect(isRecoverableWorkerFailure(new Error('worker connection interrupted'), context)).toBe(
        true
      );
    });

    it('keeps deterministic construction failures terminal', () => {
      expect(
        isRecoverableWorkerFailure(
          new Error('worker connection interrupted'),
          'createWorkerInstance'
        )
      ).toBe(false);
    });

    it('keeps tokenizer failures terminal in a recoverable worker context', () => {
      expect(
        isRecoverableWorkerFailure(
          new Error('Accurate token counting unavailable: encoder missing'),
          'worker.onerror'
        )
      ).toBe(false);
    });
  });

  describe('pruneRestartHistory', () => {
    it('prunes timestamps before the window while retaining its inclusive boundary', () => {
      const now = 100_000;
      const cutoff = now - RECOVERABLE_WORKER_RESTART_WINDOW_MS;
      const history = [cutoff - 1, cutoff, now - 1, now];

      expect(pruneRestartHistory(history, now)).toBe(3);
      expect(history).toEqual([cutoff, now - 1, now]);
    });
  });
});
