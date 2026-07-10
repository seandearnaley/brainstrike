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

  it('F6: strips a leading UTF-8 BOM before detecting the frontmatter fence', () => {
    const content = ['﻿---', 'name: Review', '---', 'body'].join('\n');
    const result = parseUserCommandFile(content);
    expect(result).toEqual({ name: 'Review', ok: true, template: 'body' });
  });

  it('F7: tolerates Claude Code multiline YAML list/comment lines inside the fence', () => {
    // `allowed-tools:` followed by `- Read` / `- Write` list items (and a `#`
    // comment) is legal Claude Code frontmatter — the list lines are ignored,
    // not treated as malformed.
    const content = [
      '---',
      'description: Ship it',
      'allowed-tools:',
      '  - Read',
      '  - Write',
      '# a comment',
      '---',
      'Commit: $ARGUMENTS',
    ].join('\n');
    const result = parseUserCommandFile(content);
    expect(result).toEqual({ description: 'Ship it', ok: true, template: 'Commit: $ARGUMENTS' });
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

  it('substitutes present positional $1..$N and leaves ABSENT positions as visible placeholders', () => {
    // Placeholder-fill (F1): an unfilled `$3` stays literal so the user can fill
    // it in the composer, never a silent empty blank.
    expect(expandUserCommandTemplate({ argString: 'alpha beta', template: '$1 | $2 | $3' })).toBe(
      'alpha | beta | $3'
    );
  });

  it('leaves a $ not followed by a digit or ARGUMENTS untouched, and keeps absent digit placeholders literal', () => {
    // `$foo` is literal; `$5` is an unfilled positional placeholder left visible.
    expect(expandUserCommandTemplate({ argString: '', template: 'for $foo and $5' })).toBe(
      'for $foo and $5'
    );
  });

  it('F1: leaves $ARGUMENTS as a visible placeholder when no args were provided', () => {
    // The pinned assistant-ui trigger closes the popover at the first space, so
    // the live selection flow always has an EMPTY arg string — the token stays
    // visible for the user to fill, never expands to a silent blank.
    expect(expandUserCommandTemplate({ argString: '', template: 'Review this: $ARGUMENTS' })).toBe(
      'Review this: $ARGUMENTS'
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
    // binds template @paths only; user args are inserted verbatim (single-pass:
    // substituted text is never re-scanned for `@`).
    expect(
      expandUserCommandTemplate({
        argString: '@evil.ts',
        mentionRootId: 'root-1',
        template: '$ARGUMENTS',
      })
    ).toBe('@evil.ts');
  });

  it('F2: does not re-scan a $<digits> that appears INSIDE the substituted argument text', () => {
    // `$100` in the arg is user data, not a positional placeholder: a second
    // pass would eat it (`positional[99]` is undefined). Single-pass keeps it.
    expect(
      expandUserCommandTemplate({
        argString: 'raise budget to $100',
        template: 'Request: $ARGUMENTS',
      })
    ).toBe('Request: raise budget to $100');
  });

  it('F2: does not re-substitute a $1 that lands inside the argument text', () => {
    // `pay $1 fee now` must stay verbatim, not become `pay pay fee now`.
    expect(
      expandUserCommandTemplate({ argString: 'pay $1 fee now', template: 'Do: $ARGUMENTS' })
    ).toBe('Do: pay $1 fee now');
  });

  it('F2: an arg containing } that flows into a template @…$1 path is directive-escaped (correct file)', () => {
    // The `}` must NOT truncate the directive `{name=…}` — the path segment is
    // encoded so the server resolves `src/a}b`, not a different `src/a`.
    const out = expandUserCommandTemplate({
      argString: 'a}b',
      mentionRootId: 'r1',
      template: 'See @src/$1',
    });
    expect(out).toContain(':file[a}b]');
    expect(out).toContain('src/a%7Db');
    // The raw `}` never leaks into the {name=…} attribute (which would truncate it).
    expect(out).not.toContain('{name=r1::src/a}b}');
  });

  it('F2: substitutes positional args inside a template @path and serializes the correct file', () => {
    expect(
      expandUserCommandTemplate({
        argString: 'foo.ts',
        mentionRootId: 'r1',
        template: 'Open @src/$1',
      })
    ).toBe('Open :file[foo.ts]{name=r1::src/foo.ts}');
  });
});
