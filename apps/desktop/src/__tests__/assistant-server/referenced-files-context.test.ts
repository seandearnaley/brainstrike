import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import { encodeFileMentionId, serializeFileMentionDirective } from '@brainstrike/agent';
import { INTERNAL_FAULT, ToolInputError } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReferencedFilesContextMessage,
  injectReferencedFilesContext,
  MAX_REFERENCED_FILES_TOTAL_CHARS,
  type WorkspaceFileReader,
} from '../../assistant-server/referenced-files-context';

const ROOT_ID = '/abs/workspace';

function runtimeWithRoot(): RuntimeData {
  return {
    provider: 'anthropic',
    workspaceRoots: [{ displayName: 'workspace', path: ROOT_ID, rootId: ROOT_ID }],
  } as RuntimeData;
}

function userMessage(text: string): AgentMessage {
  return { id: 'u1', parts: [{ text, type: 'text' }], role: 'user' };
}

function directive(rootId: string, path: string, label: string): string {
  return serializeFileMentionDirective({ id: encodeFileMentionId(rootId, path), label });
}

describe('buildReferencedFilesContextMessage', () => {
  let reader: WorkspaceFileReader;

  beforeEach(() => {
    reader = vi.fn(async (args: { rootPath: string; requestedPath: string }) => ({
      content: `// content of ${args.requestedPath}`,
      path: args.requestedPath,
      size: 10,
    }));
  });

  it('returns null when the message text has no file directives', async () => {
    const result = await buildReferencedFilesContextMessage(
      'a plain message',
      runtimeWithRoot(),
      reader
    );
    expect(result).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });

  it('reads the referenced file and builds a system context message containing its content', async () => {
    const text = `Review ${directive(ROOT_ID, 'src/app.ts', 'app.ts')} please.`;
    const result = await buildReferencedFilesContextMessage(text, runtimeWithRoot(), reader);

    expect(reader).toHaveBeenCalledWith({ requestedPath: 'src/app.ts', rootPath: ROOT_ID });
    expect(result).not.toBeNull();
    expect(result?.role).toBe('system');
    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(body).toContain('src/app.ts');
    expect(body).toContain('// content of src/app.ts');
  });

  it('qualifies headings with the root so same-path files across roots are distinct', async () => {
    const runtime = {
      provider: 'anthropic',
      workspaceRoots: [
        { displayName: 'alpha', path: '/abs/alpha', rootId: '/abs/alpha' },
        { displayName: 'beta', path: '/abs/beta', rootId: '/abs/beta' },
      ],
    } as RuntimeData;
    const text = `${directive('/abs/alpha', 'src/index.ts', 'index.ts')} and ${directive(
      '/abs/beta',
      'src/index.ts',
      'index.ts'
    )}`;
    const result = await buildReferencedFilesContextMessage(text, runtime, reader);
    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    // Both roots have `src/index.ts`; the headings must NOT collide.
    expect(body).toContain('### alpha/src/index.ts');
    expect(body).toContain('### beta/src/index.ts');
  });

  it('injects a clear unresolvable note (never silent) when the root id is unknown', async () => {
    const text = `See ${directive('unknown-root', 'src/x.ts', 'x.ts')}.`;
    const result = await buildReferencedFilesContextMessage(text, runtimeWithRoot(), reader);

    expect(reader).not.toHaveBeenCalled();
    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(body).toContain('src/x.ts');
    expect(body.toLowerCase()).toContain('could not');
  });

  it('injects a typed refusal (never silent) when the read refuses the file', async () => {
    reader = vi.fn(async () => {
      throw new ToolInputError('"src/bin.dat" is a binary file.');
    });
    const text = `See ${directive(ROOT_ID, 'src/bin.dat', 'bin.dat')}.`;
    const result = await buildReferencedFilesContextMessage(text, runtimeWithRoot(), reader);

    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(body).toContain('src/bin.dat');
    expect(body.toLowerCase()).toContain('could not');
    expect(body).toContain('is a binary file.');
  });

  it('never puts an untyped read error, or its host path, in the model message (BST-2007)', async () => {
    reader = vi.fn(async () => {
      throw Object.assign(
        new Error("ENOENT: no such file or directory, lstat '/Users/someone/project/missing.ts'"),
        { code: 'ENOENT' }
      );
    });
    const text = `See ${directive(ROOT_ID, 'missing.ts', 'missing.ts')}.`;
    const result = await buildReferencedFilesContextMessage(text, runtimeWithRoot(), reader);

    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(body).toContain(`### missing.ts\n[Could not read: ${INTERNAL_FAULT.message}]`);
    expect(body).not.toContain('/Users/');
    expect(body).not.toContain('ENOENT');
  });

  it('reads multiple referenced files in one context message', async () => {
    const text = `${directive(ROOT_ID, 'a.ts', 'a.ts')} and ${directive(ROOT_ID, 'b.ts', 'b.ts')}`;
    const result = await buildReferencedFilesContextMessage(text, runtimeWithRoot(), reader);
    expect(reader).toHaveBeenCalledTimes(2);
    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(body).toContain('// content of a.ts');
    expect(body).toContain('// content of b.ts');
  });

  it('caps the TOTAL injected size and appends an honest "N omitted" note', async () => {
    // Each file's content is ~8K chars (under the per-file 12K cap, so no
    // per-file truncation), but many of them together would blow the aggregate
    // budget. The builder must STOP injecting once the total budget is exhausted
    // and tell the model how many it skipped (never silently drop them).
    const bigBody = 'x'.repeat(8000);
    reader = vi.fn(async (args: { rootPath: string; requestedPath: string }) => ({
      content: bigBody,
      path: args.requestedPath,
      size: bigBody.length,
    }));
    const mentions = Array.from({ length: 20 }, (_unused, index) =>
      directive(ROOT_ID, `big-${index}.ts`, `big-${index}.ts`)
    ).join(' ');

    const result = await buildReferencedFilesContextMessage(mentions, runtimeWithRoot(), reader);
    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';

    // Total injected stays within the aggregate budget (with reasonable framing
    // overhead headroom — the fences/headers/note add a bounded constant).
    expect(body.length).toBeLessThanOrEqual(MAX_REFERENCED_FILES_TOTAL_CHARS + 2000);
    // At least one file was injected, and at least one was omitted with a note.
    expect(body).toContain('big-0.ts');
    expect(body.toLowerCase()).toContain('omitted to stay within the context budget');
    // The reader is not called for files past the budget cutoff.
    expect((reader as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(20);
  });

  it('wraps content in a fence LONGER than any backtick run inside it (no early break)', async () => {
    // A referenced file that contains a ``` fence (markdown / fenced code in a
    // comment) must not terminate the wrapping fence early — the wrapper fence
    // must be longer than the longest backtick run in the body.
    const fenced = ['# Heading', '```ts', 'const a = 1;', '```', 'after'].join('\n');
    reader = vi.fn(async (args: { rootPath: string; requestedPath: string }) => ({
      content: fenced,
      path: args.requestedPath,
      size: fenced.length,
    }));

    const result = await buildReferencedFilesContextMessage(
      `review ${directive(ROOT_ID, 'doc.md', 'doc.md')}`,
      runtimeWithRoot(),
      reader
    );
    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';

    // The body's longest backtick run is 3, so the wrapper must use >=4 backticks.
    expect(body).toContain('````');
    // The inner ``` fence survives intact (full file content round-trips).
    expect(body).toContain('```ts\nconst a = 1;\n```');
    // The whole file is present.
    expect(body).toContain('# Heading');
    expect(body).toContain('after');
  });
});

describe('injectReferencedFilesContext', () => {
  let reader: WorkspaceFileReader;

  beforeEach(() => {
    reader = vi.fn(async (args: { rootPath: string; requestedPath: string }) => ({
      content: `// content of ${args.requestedPath}`,
      path: args.requestedPath,
      size: 10,
    }));
  });

  it('prepends a system context message before the conversation when a file is referenced', async () => {
    const messages: AgentMessage[] = [
      userMessage(`Review ${directive(ROOT_ID, 'src/app.ts', 'app.ts')}.`),
    ];
    const next = await injectReferencedFilesContext(messages, runtimeWithRoot(), reader);

    expect(next).toHaveLength(2);
    expect(next[0]?.role).toBe('system');
    expect(next[1]).toBe(messages[0]); // original user message preserved (identity)
  });

  it('reads directives from the LAST user message only (the current turn)', async () => {
    const messages: AgentMessage[] = [
      userMessage(`old ${directive(ROOT_ID, 'old.ts', 'old.ts')}`),
      { id: 'a1', parts: [{ text: 'ok', type: 'text' }], role: 'assistant' },
      userMessage(`new ${directive(ROOT_ID, 'new.ts', 'new.ts')}`),
    ];
    const next = await injectReferencedFilesContext(messages, runtimeWithRoot(), reader);

    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith({ requestedPath: 'new.ts', rootPath: ROOT_ID });
    expect(next).toHaveLength(4);
    expect(next[0]?.role).toBe('system');
  });

  it('returns the messages unchanged when no file is referenced', async () => {
    const messages: AgentMessage[] = [userMessage('just text')];
    const next = await injectReferencedFilesContext(messages, runtimeWithRoot(), reader);
    expect(next).toBe(messages);
    expect(reader).not.toHaveBeenCalled();
  });

  it('returns the messages unchanged when there is no user message', async () => {
    const messages: AgentMessage[] = [
      { id: 'a1', parts: [{ text: 'hi', type: 'text' }], role: 'assistant' },
    ];
    const next = await injectReferencedFilesContext(messages, runtimeWithRoot(), reader);
    expect(next).toBe(messages);
  });
});
