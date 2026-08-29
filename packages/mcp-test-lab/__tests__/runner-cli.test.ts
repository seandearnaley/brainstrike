import { describe, expect, it } from 'vitest';
import { mcpLabRunnerEvidenceCommand, parseMcpLabRunnerCliArgs } from '../src/runner-cli';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const VALID_ARGS = [
  '--profile',
  'pr',
  '--ticket',
  'BST-1496',
  '--output',
  'artifacts/mcp-pr.json',
  '--sha',
  SHA,
  '--workspace-state',
  'clean',
];

function replaceValue(index: number, value: string): string[] {
  const args = [...VALID_ARGS];
  args[index] = value;
  return args;
}

describe('MCP verifier runner CLI', () => {
  it('requires explicit exact-head identity and returns a frozen selection', () => {
    const parsed = parseMcpLabRunnerCliArgs(['--', ...VALID_ARGS]);

    expect(parsed).toEqual({
      output: 'artifacts/mcp-pr.json',
      profile: 'pr',
      sha: SHA,
      ticket: 'BST-1496',
      workspaceState: 'clean',
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(mcpLabRunnerEvidenceCommand(parsed)).toBe(
      `pnpm --filter @brainstrike/mcp-test-lab verify -- --profile pr --ticket BST-1496 --output artifacts/mcp-pr.json --sha ${SHA} --workspace-state clean`
    );
  });

  it.each(
    [
      [],
      ['--profile', 'pr'],
      replaceValue(1, 'missing'),
      replaceValue(3, '1496'),
      replaceValue(5, '../a.json'),
      replaceValue(5, 'a.txt'),
      replaceValue(5, 'artifacts/mcp report.json'),
      replaceValue(5, 'artifacts/mcp;report.json'),
      replaceValue(7, 'abc'),
      replaceValue(9, 'unknown'),
      [...VALID_ARGS, '--profile', 'pr'],
    ].map((argv) => [argv] as const)
  )('fails closed for malformed argv %j', (argv) => {
    expect(() => parseMcpLabRunnerCliArgs(argv)).toThrow(/invalid MCP lab runner arguments/i);
  });
});
