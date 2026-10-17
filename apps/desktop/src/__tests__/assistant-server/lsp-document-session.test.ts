import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc/node';
import { LspReadPolicyError, withLspDocument } from '../../assistant-server/lsp-document-session';

let root: string;
let file: string;
const sendNotification = vi.fn().mockResolvedValue(undefined);
const sendRequest = vi.fn();
const connection = { sendNotification, sendRequest } as unknown as MessageConnection;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bs-lsp-session-')));
  file = path.join(root, 'main.ts');
  await fs.writeFile(file, 'export const value = 1;');
  sendNotification.mockClear();
  sendRequest.mockImplementation(() =>
    Promise.resolve({ body: { fileNames: [file] }, success: true })
  );
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(root, { force: true, recursive: true });
});

function session() {
  return {
    absolutePath: file,
    connection,
    content: 'export const value = 1;',
    languageId: 'typescript',
    rootPath: root,
  };
}

it.each([null, { success: false }, { body: { fileNames: [] }, success: true }])(
  'fails closed and closes the buffer when project provenance is unavailable: %j',
  async (result) => {
    sendRequest.mockResolvedValue(result);
    const task = vi.fn().mockResolvedValue('must not escape');
    await expect(withLspDocument(session(), task)).rejects.toBeInstanceOf(LspReadPolicyError);
    expect(task).not.toHaveBeenCalled();
    expect(sendNotification).toHaveBeenLastCalledWith('textDocument/didClose', expect.anything());
  }
);

it('bounds an unanswered project query and closes the buffer', async () => {
  vi.useFakeTimers();
  sendRequest.mockImplementation((_method, params: { arguments: unknown[] }) =>
    params.arguments[0] === 'reloadProjects' ? Promise.resolve(null) : new Promise(() => undefined)
  );
  const result = expect(withLspDocument(session(), vi.fn())).rejects.toBeInstanceOf(
    LspReadPolicyError
  );
  await vi.advanceTimersByTimeAsync(4001);
  await result;
  expect(sendNotification).toHaveBeenLastCalledWith('textDocument/didClose', expect.anything());
});

it('closes the buffer after an analysis failure', async () => {
  const failure = new Error('analysis failed');
  await expect(withLspDocument(session(), () => Promise.reject(failure))).rejects.toBe(failure);
  expect(sendNotification).toHaveBeenLastCalledWith('textDocument/didClose', expect.anything());
});

it('withholds a captured result when policy tightens during analysis', async () => {
  await expect(
    withLspDocument(session(), async () => {
      await fs.writeFile(path.join(root, '.llmignore'), 'main.ts\n');
      return 'previously allowed source';
    })
  ).rejects.toBeInstanceOf(LspReadPolicyError);
  expect(sendNotification).toHaveBeenLastCalledWith('textDocument/didClose', expect.anything());
});
