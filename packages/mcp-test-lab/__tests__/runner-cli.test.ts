import { describe, expect, it } from 'vitest';
import { mcpLabRunnerEvidenceCommand, parseMcpLabRunnerCliArgs } from '../src/runner-cli';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('MCP verifier runner CLI', () => {
  it('requires explicit exact-head identity and returns a frozen selection', () => {
    const parsed = parseMcpLabRunnerCliArgs([
      '--',
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
    ]);

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
      [
        '--profile',
        'missing',
        '--ticket',
        'BST-1496',
        '--output',
        'a.json',
        '--sha',
        SHA,
        '--workspace-state',
        'clean',
      ],
      [
        '--profile',
        'pr',
        '--ticket',
        '1496',
        '--output',
        'a.json',
        '--sha',
        SHA,
        '--workspace-state',
        'clean',
      ],
      [
        '--profile',
        'pr',
        '--ticket',
        'BST-1496',
        '--output',
        '../a.json',
        '--sha',
        SHA,
        '--workspace-state',
        'clean',
      ],
      [
        '--profile',
        'pr',
        '--ticket',
        'BST-1496',
        '--output',
        'a.txt',
        '--sha',
        SHA,
        '--workspace-state',
        'clean',
      ],
      [
        '--profile',
        'pr',
        '--ticket',
        'BST-1496',
        '--output',
        'a.json',
        '--sha',
        'abc',
        '--workspace-state',
        'clean',
      ],
      [
        '--profile',
        'pr',
        '--ticket',
        'BST-1496',
        '--output',
        'a.json',
        '--sha',
        SHA,
        '--workspace-state',
        'unknown',
      ],
      [
        '--profile',
        'pr',
        '--profile',
        'pr',
        '--ticket',
        'BST-1496',
        '--output',
        'a.json',
        '--sha',
        SHA,
        '--workspace-state',
        'clean',
      ],
    ].map((argv) => [argv] as const)
  )('fails closed for malformed argv %j', (argv) => {
    expect(() => parseMcpLabRunnerCliArgs(argv)).toThrow(/invalid MCP lab runner arguments/i);
  });
});
