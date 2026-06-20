import type { AgentMessage, RuntimeData } from '@brainstrike/agent';
import { encodeFileMentionId, serializeFileMentionDirective } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReferencedFilesContextMessage,
  injectReferencedFilesContext,
  type WorkspaceFileReader,
} from '../../assistant-server/referenced-files-context';

const ROOT_ID = '/abs/workspace';

function runtimeWithRoot(): RuntimeData {
  return {
    provider: 'anthropic',
    workspaceRoots: [{ rootId: ROOT_ID, displayName: 'workspace', path: ROOT_ID }],
  } as RuntimeData;
}

function userMessage(text: string): AgentMessage {
  return { id: 'u1', role: 'user', parts: [{ type: 'text', text }] };
}

function directive(rootId: string, path: string, label: string): string {
  return serializeFileMentionDirective({ label, id: encodeFileMentionId(rootId, path) });
}

describe('buildReferencedFilesContextMessage', () => {
  let reader: WorkspaceFileReader;

  beforeEach(() => {
    reader = vi.fn(async (args: { rootPath: string; requestedPath: string }) => ({
      path: args.requestedPath,
      size: 10,
      content: `// content of ${args.requestedPath}`,
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

    expect(reader).toHaveBeenCalledWith({ rootPath: ROOT_ID, requestedPath: 'src/app.ts' });
    expect(result).not.toBeNull();
    expect(result?.role).toBe('system');
    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    expect(body).toContain('src/app.ts');
    expect(body).toContain('// content of src/app.ts');
  });

  it('injects a clear unresolvable note (never silent) when the root id is unknown', async () => {
    const text = `See ${directive('unknown-root', 'src/x.ts', 'x.ts')}.`;
    const result = await buildReferencedFilesContextMessage(text, runtimeWithRoot(), reader);

    expect(reader).not.toHaveBeenCalled();
    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(body).toContain('src/x.ts');
    expect(body.toLowerCase()).toContain('could not');
  });

  it('injects a clear note (never silent) when the file read throws', async () => {
    reader = vi.fn(async () => {
      throw new Error('binary file');
    });
    const text = `See ${directive(ROOT_ID, 'src/bin.dat', 'bin.dat')}.`;
    const result = await buildReferencedFilesContextMessage(text, runtimeWithRoot(), reader);

    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(body).toContain('src/bin.dat');
    expect(body.toLowerCase()).toContain('could not');
    expect(body).toContain('binary file');
  });

  it('reads multiple referenced files in one context message', async () => {
    const text = `${directive(ROOT_ID, 'a.ts', 'a.ts')} and ${directive(ROOT_ID, 'b.ts', 'b.ts')}`;
    const result = await buildReferencedFilesContextMessage(text, runtimeWithRoot(), reader);
    expect(reader).toHaveBeenCalledTimes(2);
    const body = result?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
    expect(body).toContain('// content of a.ts');
    expect(body).toContain('// content of b.ts');
  });
});

describe('injectReferencedFilesContext', () => {
  let reader: WorkspaceFileReader;

  beforeEach(() => {
    reader = vi.fn(async (args: { rootPath: string; requestedPath: string }) => ({
      path: args.requestedPath,
      size: 10,
      content: `// content of ${args.requestedPath}`,
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
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
      userMessage(`new ${directive(ROOT_ID, 'new.ts', 'new.ts')}`),
    ];
    const next = await injectReferencedFilesContext(messages, runtimeWithRoot(), reader);

    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith({ rootPath: ROOT_ID, requestedPath: 'new.ts' });
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
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
    ];
    const next = await injectReferencedFilesContext(messages, runtimeWithRoot(), reader);
    expect(next).toBe(messages);
  });
});
