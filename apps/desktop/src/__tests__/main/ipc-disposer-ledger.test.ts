import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type CallExpression,
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  ScriptKind,
  ScriptTarget,
} from 'typescript';
import { describe, expect, it } from 'vitest';

const MAIN_PATH = path.resolve(import.meta.dirname, '../../main.ts');
const REGISTRATION = /^register\w*IpcHandlers$/;

interface LedgerScan {
  /** Labels passed to `ipcDisposers.add` around a registration call. */
  readonly labels: readonly string[];
  /** Registration calls whose disposer is not handed to `ipcDisposers.add`. */
  readonly unledgered: readonly string[];
}

/** True for an `ipcDisposers.add(...)` call. */
function isLedgerAdd(call: CallExpression): boolean {
  const callee = call.expression;
  return (
    isPropertyAccessExpression(callee) &&
    isIdentifier(callee.expression) &&
    callee.expression.text === 'ipcDisposers' &&
    callee.name.text === 'add'
  );
}

/**
 * Every `registerXIpcHandlers(...)` call in main must be the second argument
 * of `ipcDisposers.add(label, …)`: platform-contracts.md § "IPC contract
 * modules" makes the disposer stack the ONE holder of IPC-domain disposers.
 */
function scanIpcRegistrations(sourceText: string): LedgerScan {
  const file = createSourceFile('main.ts', sourceText, ScriptTarget.Latest, true, ScriptKind.TS);
  const labels: string[] = [];
  const unledgered: string[] = [];
  const visit = (node: Node): void => {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      REGISTRATION.test(node.expression.text)
    ) {
      const parent = node.parent;
      const label =
        isCallExpression(parent) && isLedgerAdd(parent) && parent.arguments[1] === node
          ? parent.arguments[0]
          : undefined;
      if (label && isStringLiteral(label)) {
        labels.push(label.text);
      } else {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        unledgered.push(`${node.expression.text} (main.ts:${line + 1})`);
      }
    }
    forEachChild(node, visit);
  };
  visit(file);
  return { labels, unledgered };
}

describe('IPC disposer ledger in main', () => {
  it('hands every IPC registration disposer to ipcDisposers under a unique label', () => {
    const { labels, unledgered } = scanIpcRegistrations(readFileSync(MAIN_PATH, 'utf8'));

    expect(unledgered).toEqual([]);
    // Non-vacuous: main registers dozens of IPC domains.
    expect(labels.length).toBeGreaterThan(25);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of ['workspace-open-ready', 'secrets', 'provider-auth', 'agent', 'runtime']) {
      expect(labels).toContain(label);
    }
  });

  it('flags a registration whose disposer is discarded or held elsewhere', () => {
    const { unledgered } = scanIpcRegistrations(
      [
        'registerAgentIpcHandlers();',
        'const unregister = registerRuntimeIpcHandlers();',
        "ipcDisposers.add('shell', registerShellIpcHandlers());",
        'ipcDisposers.add(label, registerGitIpcHandlers());',
      ].join('\n')
    );

    expect(unledgered).toEqual([
      'registerAgentIpcHandlers (main.ts:1)',
      'registerRuntimeIpcHandlers (main.ts:2)',
      'registerGitIpcHandlers (main.ts:4)',
    ]);
  });
});
