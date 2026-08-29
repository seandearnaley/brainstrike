import { describe, expect, it } from 'vitest';
import {
  mcpLabRunnerEvidenceCommand,
  parseMcpLabRunnerCliArgs,
  resolveMcpLabRunnerGitEvidence,
} from '../src/runner-cli';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const VALID_ARGS = ['--profile', 'pr', '--output', 'artifacts/mcp-pr.json'];

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
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(mcpLabRunnerEvidenceCommand(parsed)).toBe(
      'pnpm run verify:mcp -- --profile pr --output artifacts/mcp-pr.json'
    );
  });

  it('derives exact Git evidence instead of accepting it from argv', () => {
    const runGit = (args: readonly string[]) => (args[0] === 'rev-parse' ? SHA : ' M file.ts');
    expect(resolveMcpLabRunnerGitEvidence(runGit)).toEqual({
      commitSha: SHA,
      workspaceState: 'dirty',
    });
  });

  it.each(
    [
      [],
      ['--profile', 'pr'],
      replaceValue(1, 'missing'),
      replaceValue(3, '../a.json'),
      replaceValue(3, 'a.txt'),
      replaceValue(3, 'artifacts/mcp report.json'),
      replaceValue(3, 'artifacts/mcp;report.json'),
      [...VALID_ARGS, '--profile', 'pr'],
    ].map((argv) => [argv] as const)
  )('fails closed for malformed argv %j', (argv) => {
    expect(() => parseMcpLabRunnerCliArgs(argv)).toThrow(/invalid MCP lab runner arguments/i);
  });
});
