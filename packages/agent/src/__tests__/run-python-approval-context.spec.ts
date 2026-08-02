/**
 * BST-1070: the server-computed execution context for `run_python` approvals.
 *
 * The card and the execution must agree by construction, so these tests pin
 * the derivation to what `run-python-tool.ts` actually does: network
 * inexpressible, scratch-only writes under os.tmpdir(), permissive-default
 * reads, the shared timeout default. The narrowing is the tool's OWN strict
 * schema — malformed args yield NO context (the card's fail-safe path), never
 * a guessed one.
 */

import os from 'node:os';
import { isCodeExecutionApprovalContext } from '@brainstrike/assistant-contract/tool-approval';
import { describe, expect, it } from 'vitest';
import { MAX_EXEC_TIMEOUT_MS } from '../code-execution';
import {
  computeExecutionContextFingerprint,
  RUN_PYTHON_DEFAULT_TIMEOUT_MS,
  resolveRunPythonExecutionContext,
} from '../tools/run-python-approval-context';
import { RUN_PYTHON_DEFAULT_TIMEOUT_MS as TOOL_DEFAULT_TIMEOUT_MS } from '../tools/run-python-tool';

describe('resolveRunPythonExecutionContext', () => {
  it('derives the context the execute path will actually use', () => {
    const context = resolveRunPythonExecutionContext({ code: 'print(1)' });
    expect(context).toBeDefined();
    expect(isCodeExecutionApprovalContext(context)).toBe(true);
    expect(context).toMatchObject({
      allowedDomains: [],
      allowRead: [],
      allowWrite: [],
      defaultReadAccess: 'permissive',
      executorKind: 'fence',
      language: 'python',
      scratchParentDir: os.tmpdir(),
      timeoutMs: RUN_PYTHON_DEFAULT_TIMEOUT_MS,
    });
  });

  it('carries requested domains into the context with a distinct fingerprint (Gate B)', () => {
    const context = resolveRunPythonExecutionContext({
      allowedDomains: ['pypi.org', '*.githubusercontent.com'],
      code: 'print(1)',
    });
    expect(context).toMatchObject({
      allowedDomains: ['pypi.org', '*.githubusercontent.com'],
    });
    const offline = resolveRunPythonExecutionContext({ code: 'print(1)' });
    expect(context?.policyFingerprint).not.toBe(offline?.policyFingerprint);
  });

  it('respects an explicit timeout', () => {
    expect(
      resolveRunPythonExecutionContext({ code: 'print(1)', timeoutMs: 120_000 })
    ).toMatchObject({ timeoutMs: 120_000 });
  });

  it('shares the timeout default with the tool itself — the card must state the terms the run honours', () => {
    expect(RUN_PYTHON_DEFAULT_TIMEOUT_MS).toBe(TOOL_DEFAULT_TIMEOUT_MS);
  });

  it('returns undefined for args the tool schema would reject — the fail-safe path, never a guess', () => {
    expect(resolveRunPythonExecutionContext(undefined)).toBeUndefined();
    expect(resolveRunPythonExecutionContext('print(1)')).toBeUndefined();
    expect(resolveRunPythonExecutionContext({})).toBeUndefined();
    expect(resolveRunPythonExecutionContext({ code: '' })).toBeUndefined();
    expect(resolveRunPythonExecutionContext({ code: 42 })).toBeUndefined();
    // Unknown key: the schema is .strict() — a field this build does not
    // understand must not be described as if it were understood.
    expect(
      resolveRunPythonExecutionContext({ code: 'print(1)', unknownField: true })
    ).toBeUndefined();
    // Gate B: domain SHAPES the seam rejects fail resolution too — a bare
    // wildcard or single-label wildcard must never reach a card.
    expect(
      resolveRunPythonExecutionContext({ allowedDomains: ['*'], code: 'print(1)' })
    ).toBeUndefined();
    expect(
      resolveRunPythonExecutionContext({ allowedDomains: ['*.com'], code: 'print(1)' })
    ).toBeUndefined();
    expect(
      resolveRunPythonExecutionContext({ allowedDomains: [], code: 'print(1)' })
    ).toBeUndefined();
    expect(
      resolveRunPythonExecutionContext({ code: 'print(1)', timeoutMs: MAX_EXEC_TIMEOUT_MS + 1 })
    ).toBeUndefined();
    expect(resolveRunPythonExecutionContext({ code: 'print(1)', timeoutMs: 1.5 })).toBeUndefined();
  });

  it('fingerprint is deterministic and sensitive to every field', () => {
    const a = resolveRunPythonExecutionContext({ code: 'print(1)' });
    const b = resolveRunPythonExecutionContext({ code: 'print("different code same policy")' });
    const c = resolveRunPythonExecutionContext({ code: 'print(1)', timeoutMs: 60_000 });
    if (!(a && b && c)) {
      throw new Error('expected contexts to resolve');
    }
    // Same policy fields => same fingerprint (the code itself is not a policy
    // fact; it is shown verbatim on the card instead).
    expect(a.policyFingerprint).toBe(b.policyFingerprint);
    expect(a.policyFingerprint).not.toBe(c.policyFingerprint);

    const { policyFingerprint: _fp, ...fields } = a;
    expect(computeExecutionContextFingerprint(fields)).toBe(a.policyFingerprint);
    expect(computeExecutionContextFingerprint({ ...fields, defaultReadAccess: 'none' })).not.toBe(
      a.policyFingerprint
    );
    expect(
      computeExecutionContextFingerprint({ ...fields, allowedDomains: ['pypi.org'] })
    ).not.toBe(a.policyFingerprint);
    expect(computeExecutionContextFingerprint({ ...fields, executorKind: 'vm' })).not.toBe(
      a.policyFingerprint
    );
    expect(
      computeExecutionContextFingerprint({ ...fields, scratchParentDir: '/elsewhere' })
    ).not.toBe(a.policyFingerprint);
  });
});
