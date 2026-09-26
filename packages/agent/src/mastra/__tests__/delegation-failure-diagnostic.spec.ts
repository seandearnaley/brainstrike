import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { addLogListener, createLogger, LogLevel, type LogRecord } from '@brainstrike/logging';
import { logRecordToDiagnosticEvent } from '@brainstrike/utils/diagnostics';
import { ErrorCategory, ErrorDomain, MastraError } from '@mastra/core/error';
import { describe, expect, it } from 'vitest';
import { summarizeDelegationFailure } from '../delegation-failure-diagnostic';
import { createDelegationConfig, createDelegationOutcomeCapture } from '../subagent-delegation';

const persona: AssistantPersonaDefinition = {
  allowedToolIds: [],
  description: 'Explore',
  id: 'explore',
  instructions: 'Explore.',
  label: 'Explorer',
  maxSteps: 8,
};

describe('delegation failure diagnostics', () => {
  it.each([401, 403])(
    'recognizes nested embedding access failure %i and returns fixed supervisor feedback',
    async (statusCode) => {
      const providerError = Object.assign(new Error('secret provider response'), {
        requestBodyValues: { input: 'secret prompt' },
        statusCode,
      });
      const probeError = new MastraError(
        {
          category: ErrorCategory.THIRD_PARTY,
          domain: ErrorDomain.MASTRA_VECTOR,
          id: 'MASTRA_MEMORY_GET_EMBEDDING_DIMENSION_FAILED',
          text: 'Failed to determine embedder dimension.',
        },
        providerError
      );
      const wrapped = new MastraError(
        {
          category: ErrorCategory.USER,
          domain: ErrorDomain.AGENT,
          id: 'AGENT_AGENT_TOOL_EXECUTION_FAILED',
          text: 'Generic worker failure',
        },
        probeError
      );
      expect(summarizeDelegationFailure(wrapped)).toEqual({
        causeCategory: 'known-internal',
        causeReason: 'memory-embedding-access-denied',
      });
      const config = createDelegationConfig({
        abortSignal: new AbortController().signal,
        logger: createLogger('DelegationDiagnosticTest'),
        personasById: new Map([['explore', persona]]),
        subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      });
      const completion = {
        bail: () => undefined,
        duration: 10,
        error: wrapped,
        iteration: 1,
        messages: [],
        parentAgentId: 'parent',
        parentAgentName: 'Parent',
        primitiveId: 'explore',
        primitiveType: 'agent' as const,
        prompt: 'secret prompt',
        result: { text: '' },
        runId: 'run-1',
        success: false,
        toolCallId: 'failed-call',
      } as Parameters<NonNullable<typeof config.onDelegationComplete>>[0];
      const result = await config.onDelegationComplete?.(completion);
      expect(result).toMatchObject({
        feedback:
          "Subagent could not start because semantic recall's embedding request was denied. Check the embedding provider credentials and access, then retry in a new run.",
        resultText: expect.stringContaining('failed before completing the task'),
      });
      expect(JSON.stringify(result)).not.toMatch(/secret prompt|secret provider/);
    }
  );

  it('returns safe generic guidance when the stream wrapper has lost provider status', async () => {
    const probeError = new MastraError(
      {
        category: ErrorCategory.THIRD_PARTY,
        domain: ErrorDomain.MASTRA_VECTOR,
        id: 'MASTRA_MEMORY_GET_EMBEDDING_DIMENSION_FAILED',
      },
      new Error('secret provider response')
    );
    const wrapped = new MastraError(
      {
        category: ErrorCategory.USER,
        domain: ErrorDomain.AGENT,
        id: 'AGENT_STREAM_FAILED',
      },
      probeError
    );
    expect(summarizeDelegationFailure(wrapped)).toEqual({
      causeCategory: 'known-internal',
      causeReason: 'memory-embedding-probe-failed',
    });
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: createLogger('DelegationDiagnosticTest'),
      personasById: new Map([['explore', persona]]),
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    const completion = {
      bail: () => undefined,
      duration: 10,
      error: wrapped,
      iteration: 1,
      messages: [],
      parentAgentId: 'parent',
      parentAgentName: 'Parent',
      primitiveId: 'explore',
      primitiveType: 'agent' as const,
      prompt: 'secret prompt',
      result: { text: '' },
      runId: 'run-1',
      success: false,
      toolCallId: 'failed-call',
    } as Parameters<NonNullable<typeof config.onDelegationComplete>>[0];
    const result = await config.onDelegationComplete?.(completion);
    expect(result).toMatchObject({
      feedback:
        'Subagent could not start because semantic recall could not check its embedding provider. Check the embedding provider configuration and availability, then retry in a new run.',
    });
    expect(JSON.stringify(result)).not.toMatch(/secret prompt|secret provider|credentials/);
  });

  it('classifies only fixed internal reasons', () => {
    const error = new Error('secret prompt sensitive-credential-test-marker');
    error.cause = { providerRequest: 'secret prompt' };
    expect(summarizeDelegationFailure(error)).toEqual({ causeCategory: 'unclassified' });
    expect(summarizeDelegationFailure({ message: 'secret prompt' })).toEqual({
      causeCategory: 'unclassified',
    });
    expect(summarizeDelegationFailure(undefined)).toEqual({ causeCategory: 'unreported' });
    expect(
      summarizeDelegationFailure(
        Object.assign(new Error('generic'), {
          name: 'DelegatedConversationIdentityError',
          reason: 'host-transaction-unavailable',
        })
      )
    ).toEqual({
      causeCategory: 'known-internal',
      causeReason: 'host-transaction-unavailable',
    });
  });

  it('sends a failed child through the diagnostic sink without task or provider content', async () => {
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    const error = new Error('Child execution configuration has no trusted native admission.');
    error.stack = 'provider stack with secret prompt and sensitive-credential-test-marker';
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      logger: createLogger('DelegationDiagnosticTest'),
      personasById: new Map([['explore', persona]]),
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    const completion = {
      bail: () => undefined,
      duration: 10,
      error,
      iteration: 1,
      messages: [],
      parentAgentId: 'parent',
      parentAgentName: 'Parent',
      primitiveId: 'explore',
      primitiveType: 'agent' as const,
      prompt: 'secret prompt',
      result: {
        text: '',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          providerEnvelope: 'secret prompt',
          totalTokens: 0,
        },
      },
      runId: 'run-1',
      success: false,
      toolCallId: 'failed-call',
    } as Parameters<NonNullable<typeof config.onDelegationComplete>>[0];
    try {
      await config.onDelegationComplete?.(completion);
    } finally {
      remove();
    }

    const failure = records.find((record) => record.message === 'Subagent delegation failed');
    expect(failure?.level).toBe(LogLevel.ERROR);
    expect(failure?.args).toEqual([
      'Subagent delegation failed',
      {
        causeCategory: 'known-internal',
        causeReason: 'child-execution-not-admitted',
        code: 'subagent_delegation_failed',
        durationMs: 10,
        parentRuntimeRunId: 'run-1',
        parentToolCallId: 'failed-call',
        personaId: 'explore',
      },
    ]);
    const diagnostic =
      failure &&
      logRecordToDiagnosticEvent(failure, {
        appVersion: 'test',
        makeId: () => 'diagnostic-1',
        platform: 'test',
        sessionId: 'session-1',
        source: 'test',
      });
    expect(diagnostic).toMatchObject({
      code: 'subagent_delegation_failed',
      context: { causeReason: 'child-execution-not-admitted', parentToolCallId: 'failed-call' },
      severity: 'error',
    });
    expect(JSON.stringify({ diagnostic, failure })).not.toMatch(
      /secret prompt|sk-supersecret|providerEnvelope/
    );
  });

  it('does not log explicit parent Stop as a failed delegation or send failure feedback', async () => {
    const attempt = new AbortController();
    const parentStop = new AbortController();
    const outcomes = createDelegationOutcomeCapture();
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    const config = createDelegationConfig({
      abortSignal: attempt.signal,
      delegationOutcomes: outcomes,
      externalStopSignal: parentStop.signal,
      logger: createLogger('DelegationDiagnosticTest'),
      personasById: new Map([['explore', persona]]),
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    parentStop.abort(new Error('User stopped the run'));
    attempt.abort(parentStop.signal.reason);
    try {
      const result = await config.onDelegationComplete?.({
        bail: () => undefined,
        duration: 10,
        error: new DOMException('Aborted', 'AbortError'),
        iteration: 1,
        messages: [],
        parentAgentId: 'parent',
        parentAgentName: 'Parent',
        primitiveId: 'explore',
        primitiveType: 'agent',
        prompt: 'secret prompt',
        result: { text: '' },
        runId: 'run-1',
        success: false,
        toolCallId: 'stopped-call',
      });
      expect(result).toBeUndefined();
    } finally {
      remove();
    }
    expect(outcomes.failed('stopped-call', 'run-1')).toBe(false);
    expect(records.some((record) => record.message === 'Subagent delegation failed')).toBe(false);
    expect(records.some((record) => record.message === 'Subagent delegation cancelled')).toBe(true);
  });

  it('keeps an AbortError failed when only the attempt timed out', async () => {
    const attempt = new AbortController();
    const parentStop = new AbortController();
    attempt.abort(new Error('Attempt timed out'));
    const outcomes = createDelegationOutcomeCapture();
    const records: LogRecord[] = [];
    const remove = addLogListener((record) => records.push(record));
    const config = createDelegationConfig({
      abortSignal: attempt.signal,
      delegationOutcomes: outcomes,
      externalStopSignal: parentStop.signal,
      logger: createLogger('DelegationDiagnosticTest'),
      personasById: new Map([['explore', persona]]),
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    try {
      await config.onDelegationComplete?.({
        bail: () => undefined,
        duration: 10,
        error: new DOMException('Aborted', 'AbortError'),
        iteration: 1,
        messages: [],
        parentAgentId: 'parent',
        parentAgentName: 'Parent',
        primitiveId: 'explore',
        primitiveType: 'agent',
        prompt: 'secret prompt',
        result: { text: '' },
        runId: 'run-1',
        success: false,
        toolCallId: 'timed-out-call',
      });
    } finally {
      remove();
    }
    expect(outcomes.failed('timed-out-call', 'run-1')).toBe(true);
    expect(records.some((record) => record.message === 'Subagent delegation failed')).toBe(true);
  });
});
