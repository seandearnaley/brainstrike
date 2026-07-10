import { describe, expect, it } from 'vitest';
import {
  deriveUserCommandId,
  expandUserCommandTemplate,
  extractUserCommandArgString,
  parseUserCommandFile,
} from '../user-slash-commands.js';

describe('parseUserCommandFile', () => {
  it('treats a file with no frontmatter as a whole-file template', () => {
    const result = parseUserCommandFile('Summarize this: $ARGUMENTS');
    expect(result).toEqual({ ok: true, template: 'Summarize this: $ARGUMENTS' });
  });

  it('extracts name/description frontmatter and returns the body as the template', () => {
    const content = ['---', 'name: Review', 'description: Review a file', '---', 'Review @$1'].join(
      '\n'
    );
    const result = parseUserCommandFile(content);
    expect(result).toEqual({
      description: 'Review a file',
      name: 'Review',
      ok: true,
      template: 'Review @$1',
    });
  });

  it('ignores unrecognized frontmatter keys (Claude Code compat) without erroring', () => {
    const content = [
      '---',
      'description: Ship it',
      'allowed-tools: Bash(git:*)',
      'argument-hint: [message]',
      '---',
      'Commit: $ARGUMENTS',
    ].join('\n');
    const result = parseUserCommandFile(content);
    expect(result).toEqual({ description: 'Ship it', ok: true, template: 'Commit: $ARGUMENTS' });
  });

  it('fails closed on unterminated frontmatter (never silently half-parses)', () => {
    const content = ['---', 'name: Broken', 'Review this'].join('\n');
    const result = parseUserCommandFile(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/unterminated/i);
    }
  });

  it('fails closed on a malformed frontmatter line (no key: value)', () => {
    const content = ['---', 'this is not valid', '---', 'body'].join('\n');
    const result = parseUserCommandFile(content);
    expect(result.ok).toBe(false);
  });
});

describe('deriveUserCommandId', () => {
  it('namespaces nested directories with a colon and strips the .md extension', () => {
    expect(deriveUserCommandId('git/commit.md')).toBe('git:commit');
    expect(deriveUserCommandId('review.md')).toBe('review');
    expect(deriveUserCommandId('a/b/c.md')).toBe('a:b:c');
  });
});

describe('extractUserCommandArgString', () => {
  it('returns the text after /commandId as the raw argument string', () => {
    expect(extractUserCommandArgString('/review src/foo.ts extra', 'review')).toBe(
      'src/foo.ts extra'
    );
  });

  it('returns an empty string when the command was selected with no arguments', () => {
    expect(extractUserCommandArgString('/review', 'review')).toBe('');
  });

  it('handles namespaced (colon) command ids', () => {
    expect(extractUserCommandArgString('/git:commit fix the bug', 'git:commit')).toBe(
      'fix the bug'
    );
  });

  it('returns null when the composer text does not invoke the command', () => {
    expect(extractUserCommandArgString('hello world', 'review')).toBeNull();
  });
});

describe('expandUserCommandTemplate', () => {
  it('substitutes $ARGUMENTS with the full argument string', () => {
    expect(
      expandUserCommandTemplate({ argString: 'one two three', template: 'Q: $ARGUMENTS' })
    ).toBe('Q: one two three');
  });

  it('substitutes positional $1..$N and leaves missing positions empty', () => {
    expect(expandUserCommandTemplate({ argString: 'alpha beta', template: '$1 | $2 | $3' })).toBe(
      'alpha | beta | '
    );
  });

  it('leaves a $ not followed by a digit or ARGUMENTS untouched, but expands digit placeholders', () => {
    // `$foo` is literal; `$5` is a positional placeholder (empty when absent).
    expect(expandUserCommandTemplate({ argString: '', template: 'for $foo and $5' })).toBe(
      'for $foo and '
    );
  });

  it('converts @path tokens into file directives when a mention root id is bound', () => {
    expect(
      expandUserCommandTemplate({
        argString: '',
        mentionRootId: 'root-1',
        template: 'Review @src/foo.ts please',
      })
    ).toBe('Review :file[foo.ts]{name=root-1::src/foo.ts} please');
  });

  it('leaves @path tokens as literal text when no mention root id is bound', () => {
    expect(
      expandUserCommandTemplate({ argString: '', template: 'Review @src/foo.ts please' })
    ).toBe('Review @src/foo.ts please');
  });

  it('SECURITY: never executes or expands shell !`command` syntax — it stays inert text', () => {
    const template = 'Before !`rm -rf /` after $ARGUMENTS';
    const out = expandUserCommandTemplate({ argString: 'x', mentionRootId: 'root-1', template });
    expect(out).toBe('Before !`rm -rf /` after x');
    expect(out).toContain('!`rm -rf /`');
  });

  it('inserts user-supplied @ argument text as literal (only template @paths become directives)', () => {
    // The arg text `@evil.ts` must NOT be turned into a directive — expansion
    // binds template @paths only; user args are inserted verbatim.
    expect(
      expandUserCommandTemplate({
        argString: '@evil.ts',
        mentionRootId: 'root-1',
        template: '$ARGUMENTS',
      })
    ).toBe('@evil.ts');
  });
});
