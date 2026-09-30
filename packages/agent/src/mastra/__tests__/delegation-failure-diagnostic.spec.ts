import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract/subagent-settings';
import { addLogListener, createLogger, LogLevel, type LogRecord } from '@brainstrike/logging';
import { logRecordToDiagnosticEvent } from '@brainstrike/utils/diagnostics';
import { MessageList } from '@mastra/core/agent';
import { ErrorCategory, ErrorDomain, MastraError } from '@mastra/core/error';
import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it } from 'vitest';
import { createDelegatedConversationBinding } from '../delegated-conversation-binding';
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
  it.each([
    { admitFirst: false, ownerAbort: false },
    { admitFirst: false, ownerAbort: true },
    { admitFirst: true, ownerAbort: false },
  ])(
    'preserves persist fault and admission evidence (owner abort=$ownerAbort, prior admission=$admitFirst)',
    async ({ admitFirst, ownerAbort }) => {
      const stop = new AbortController();
      const attempt = new AbortController();
      const stopRun = () => {
        stop.abort(new Error('selected Stop'));
        attempt.abort(stop.signal.reason);
      };
      let persistCalls = 0;
      const binding = createDelegatedConversationBinding(async () => {
        persistCalls += 1;
        if (admitFirst && persistCalls === 1) {
          return;
        }
        if (ownerAbort) {
          stopRun();
          throw new Error('wrapped Stop', { cause: stop.signal.reason });
        }
        throw Object.assign(new Error('independent private persist fault'), { statusCode: 503 });
      });
      const outcomes = createDelegationOutcomeCapture();
      const config = createDelegationConfig({
        abortSignal: attempt.signal,
        conversationBinding: binding,
        delegationOutcomes: outcomes,
        externalStopSignal: stop.signal,
        logger: createLogger('DelegationDiagnosticTest'),
        personasById: new Map([['explore', persona]]),
        subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
      });
      const context = {
        iteration: 1,
        messages: [],
        params: {},
        parentAgentId: 'parent',
        parentAgentName: 'Parent',
        primitiveId: 'explore',
        primitiveType: 'agent' as const,
        prompt: 'private',
        requestContext: new RequestContext(),
        resourceId: 'owner',
        runId: 'run-1',
        threadId: 'root',
        toolCallId: 'failed-call',
      };
      await config.onDelegationStart?.(context);
      context.requestContext.set('MastraMemory', {
        resourceId: 'child-owner',
        thread: { id: 'child' },
      });
      const processInput = () =>
        binding.inputProcessor.processInput?.({
          abort(reason): never {
            throw new Error(reason);
          },
          messageList: new MessageList(),
          messages: [],
          requestContext: context.requestContext,
          retryCount: 0,
          state: {},
          systemMessages: [],
        });
      if (admitFirst) {
        await processInput();
        await binding.hooks?.afterToolCall?.({
          context: { threadId: 'root', toolCallId: 'failed-call' },
          input: { prompt: 'private' },
          output: undefined,
          toolName: 'agent-explore',
        });
        context.requestContext = new RequestContext();
        await config.onDelegationStart?.(context);
        context.requestContext.set('MastraMemory', {
          resourceId: 'child-owner',
          thread: { id: 'child' },
        });
      }
      await expect(processInput()).rejects.toThrow();
      stopRun();
      const result = await config.onDelegationComplete?.({
        bail: () => undefined,
        duration: 1,
        error: stop.signal.reason,
        iteration: 1,
        messages: [],
        parentAgentId: 'parent',
        parentAgentName: 'Parent',
        primitiveId: 'explore',
        primitiveType: 'agent',
        prompt: 'private',
        result: { text: '' },
        runId: 'run-1',
        success: false,
        toolCallId: 'failed-call',
      });
      expect(
        binding.readStartupEvidence?.({
          parentRuntimeRunId: 'run-1',
          parentToolCallId: 'failed-call',
        })?.failureIsOwnerAbort
      ).toBe(ownerAbort);
      expect(outcomes.failed('failed-call', 'run-1')).toBe(!ownerAbort);
      if (ownerAbort) {
        expect(result).toBeUndefined();
      } else {
        expect(result?.feedback).toContain(
          admitFirst
            ? 'Any partial results remain in its child conversation'
            : 'No admitted child conversation was observed'
        );
      }
    }
  );
  it('retains an observed binding failure when native completion omits its error', () => {
    const observed = summarizeDelegationFailure(
      Object.assign(new Error('Trusted delegated context exceeds its 64 KiB budget.'), {
        statusCode: 503,
      })
    );
    expect(summarizeDelegationFailure(undefined, observed)).toEqual(observed);
  });

  it('does not let a raced Stop replace an observed internal binding failure', async () => {
    const stop = new AbortController();
    const attempt = new AbortController();
    stop.abort(new Error('selected Stop'));
    attempt.abort(stop.signal.reason);
    const outcomes = createDelegationOutcomeCapture();
    const config = createDelegationConfig({
      abortSignal: attempt.signal,
      conversationBinding: {
        ...createDelegatedConversationBinding(async () => undefined),
        readStartupEvidence: () => ({
          failure: summarizeDelegationFailure(
            new Error('Trusted delegated context exceeds its 64 KiB budget.')
          ),
          startupBoundary: 'child-input-started',
        }),
      },
      delegationOutcomes: outcomes,
      externalStopSignal: stop.signal,
      logger: createLogger('DelegationDiagnosticTest'),
      personasById: new Map([['explore', persona]]),
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    const result = await config.onDelegationComplete?.({
      bail: () => undefined,
      duration: 1,
      error: stop.signal.reason,
      iteration: 1,
      messages: [],
      parentAgentId: 'parent',
      parentAgentName: 'Parent',
      primitiveId: 'explore',
      primitiveType: 'agent',
      prompt: 'private',
      result: { text: '' },
      runId: 'run-1',
      success: false,
      toolCallId: 'failed-call',
    });
    expect(outcomes.failed('failed-call', 'run-1')).toBe(true);
    expect(result?.feedback).toContain('No admitted child conversation was observed');
  });
  it('preserves safe evidence around hostile getters and stops cyclic/deep causes', () => {
    const error = Object.assign(new Error('private'), {
      id: 'AGENT_STREAM_FAILED',
      statusCode: 502,
    });
    Object.defineProperty(error, 'message', {
      get: () => {
        throw new Error('private getter');
      },
    });
    Object.defineProperty(error, 'cause', { get: () => error });
    expect(summarizeDelegationFailure(error)).toEqual({
      causeCategory: 'unclassified',
      frameworkErrorIds: ['AGENT_STREAM_FAILED'],
      httpStatus: 502,
    });
    let deep: Error = Object.assign(new Error('private'), { statusCode: 401 });
    for (let index = 0; index < 5; index += 1) {
      deep = new Error('private', { cause: deep });
    }
    expect(summarizeDelegationFailure(deep)).toEqual({ causeCategory: 'unclassified' });
  });
  it('retains only allowlisted framework identifiers and observed HTTP status', () => {
    const cause = Object.assign(new Error('secret provider response'), { statusCode: 429 });
    const error = new MastraError(
      {
        category: ErrorCategory.USER,
        domain: ErrorDomain.AGENT,
        id: 'AGENT_INPUT_PROCESSOR_ERROR',
        text: 'secret input',
      },
      cause
    );
    expect(summarizeDelegationFailure(error)).toEqual({
      causeCategory: 'unclassified',
      frameworkErrorIds: ['AGENT_INPUT_PROCESSOR_ERROR'],
      httpStatus: 429,
    });
    expect(
      summarizeDelegationFailure(
        Object.assign(new Error('private'), {
          id: 'AGENT_SECRET_CREDENTIAL',
          statusCode: 700,
        })
      )
    ).toEqual({ causeCategory: 'unclassified' });
  });

  it.each([
    { expected: 'Child admission could not be established', observer: 'native-only' },
    { expected: 'Child admission could not be established', observer: 'binding-no-observer' },
    { expected: 'No admitted child conversation was observed', observer: 'binding-observer' },
  ])('reports only observed child admission ($observer)', async ({ expected, observer }) => {
    const binding = createDelegatedConversationBinding(async () => undefined);
    const config = createDelegationConfig({
      abortSignal: new AbortController().signal,
      ...(observer === 'native-only'
        ? {}
        : {
            conversationBinding:
              observer === 'binding-observer'
                ? binding
                : {
                    endStalledExecution: binding.endStalledExecution,
                    inputProcessor: binding.inputProcessor,
                    prepare: binding.prepare,
                  },
          }),
      logger: createLogger('DelegationDiagnosticTest'),
      personasById: new Map([['explore', persona]]),
      subagentSettings: DEFAULT_RUNTIME_SUBAGENT_SETTINGS,
    });
    const result = await config.onDelegationComplete?.({
      bail: () => undefined,
      duration: 1,
      error: new Error('private'),
      iteration: 1,
      messages: [],
      parentAgentId: 'parent',
      parentAgentName: 'Parent',
      primitiveId: 'explore',
      primitiveType: 'agent',
      prompt: 'private',
      result: { subAgentThreadId: 'native-allocated-thread', text: '' },
      runId: 'run-1',
      success: false,
      toolCallId: 'failed-call',
    });
    expect(result?.resultText).toContain(expected);
    expect(result?.resultText).not.toContain('partial results remain');
  });
  it.each([
    { expected: 502, status: 502, statusCode: '503' },
    { expected: 503, status: 503, statusCode: 700 },
    { expected: 429, status: 503, statusCode: 429 },
  ])('retains the first valid numeric status ($statusCode/$status)', (fields) => {
    expect(summarizeDelegationFailure(Object.assign(new Error('private'), fields))).toEqual({
      causeCategory: 'unclassified',
      httpStatus: fields.expected,
    });
  });
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
        frameworkErrorIds: [
          'AGENT_AGENT_TOOL_EXECUTION_FAILED',
          'MASTRA_MEMORY_GET_EMBEDDING_DIMENSION_FAILED',
        ],
        httpStatus: statusCode,
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
      frameworkErrorIds: ['AGENT_STREAM_FAILED', 'MASTRA_MEMORY_GET_EMBEDDING_DIMENSION_FAILED'],
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

  it('does not borrow an unrelated outer 401 for an embedding probe failure', () => {
    const probeError = new MastraError(
      {
        category: ErrorCategory.THIRD_PARTY,
        domain: ErrorDomain.MASTRA_VECTOR,
        id: 'MASTRA_MEMORY_GET_EMBEDDING_DIMENSION_FAILED',
      },
      new Error('provider unavailable')
    );
    const unrelatedOuter = Object.assign(new Error('outer request denied', { cause: probeError }), {
      statusCode: 401,
    });
    expect(summarizeDelegationFailure(unrelatedOuter)).toEqual({
      causeCategory: 'known-internal',
      causeReason: 'memory-embedding-probe-failed',
      frameworkErrorIds: ['MASTRA_MEMORY_GET_EMBEDDING_DIMENSION_FAILED'],
      httpStatus: 401,
    });
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
        error: parentStop.signal.reason,
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

  it.each([new Error('independent child failure'), undefined])(
    'keeps independent or unreported child failure visible when Stop also races',
    async (childError) => {
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
          ...(childError ? { error: childError } : {}),
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
          toolCallId: 'independent-failure',
        });
        expect(result?.resultText).toContain('failed before completing the task');
      } finally {
        remove();
      }
      expect(outcomes.failed('independent-failure', 'run-1')).toBe(true);
      expect(records.some((record) => record.message === 'Subagent delegation failed')).toBe(true);
      expect(records.some((record) => record.message === 'Subagent delegation cancelled')).toBe(
        false
      );
    }
  );

  it('recognizes the propagated Stop reason through a native error wrapper', async () => {
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
    parentStop.abort(new Error('Assistant run canceled by user.'));
    attempt.abort(parentStop.signal.reason);
    try {
      const result = await config.onDelegationComplete?.({
        bail: () => undefined,
        duration: 10,
        error: new Error('native child stopped', { cause: parentStop.signal.reason }),
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

  it('keeps an attempt timeout failed when a user Stop arrives afterward', async () => {
    const attempt = new AbortController();
    const parentStop = new AbortController();
    attempt.abort(new Error('Attempt timed out'));
    parentStop.abort(new Error('Assistant run canceled by user.'));
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
        toolCallId: 'timeout-before-stop',
      });
    } finally {
      remove();
    }
    expect(outcomes.failed('timeout-before-stop', 'run-1')).toBe(true);
    expect(records.some((record) => record.message === 'Subagent delegation failed')).toBe(true);
    expect(records.some((record) => record.message === 'Subagent delegation cancelled')).toBe(
      false
    );
  });
});
