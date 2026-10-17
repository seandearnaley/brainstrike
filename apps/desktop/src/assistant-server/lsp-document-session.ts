import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertNotAgentIgnored,
  createAgentIgnoreGuard,
  isWithinRoot,
  QUERY_TIMEOUT_MS,
} from '@brainstrike/host-capabilities/native-tools';
import type { MessageConnection } from 'vscode-jsonrpc/node';

/** No semantic group is verified when its inputs cannot clear read policy. */
export class LspReadPolicyError extends Error {
  constructor() {
    super(
      'Semantic results withheld: cannot verify that every TypeScript project source is readable under this root’s credential and agent-ignore policy. Hover, locations and diagnostics are unknown.'
    );
  }
}

interface DocumentSession {
  absolutePath: string;
  bundledTsserverPath?: string | undefined;
  connection: MessageConnection;
  content: string;
  languageId: string;
  rootPath: string;
}

async function tsserverRequest(
  connection: MessageConnection,
  command: string,
  args: Record<string, unknown>,
  expectsResult = true
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      connection.sendRequest('workspace/executeCommand', {
        arguments: [command, args, { expectsResult }],
        command: 'typescript.tsserverRequest',
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LspReadPolicyError()), QUERY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function projectFiles(result: unknown): string[] {
  if (
    result &&
    typeof result === 'object' &&
    'success' in result &&
    result.success === true &&
    'body' in result &&
    result.body &&
    typeof result.body === 'object' &&
    'fileNames' in result.body &&
    Array.isArray(result.body.fileNames) &&
    result.body.fileNames.length > 0 &&
    result.body.fileNames.every((file): file is string => typeof file === 'string')
  ) {
    return result.body.fileNames;
  }
  throw new LspReadPolicyError();
}

/** A fresh operation-local guard: tightening an ignore rule takes effect on
 * the next operation. Only the pinned compiler's standard libs may sit outside
 * the selected root; arbitrary external declarations can carry private literals. */
async function assertProjectReadable(session: DocumentSession): Promise<void> {
  try {
    const files = projectFiles(
      await tsserverRequest(session.connection, 'projectInfo', {
        file: session.absolutePath,
        needFileNameList: true,
      })
    );
    const root = await fs.realpath(session.rootPath);
    const library = session.bundledTsserverPath
      ? path.dirname(await fs.realpath(session.bundledTsserverPath))
      : undefined;
    const guard = createAgentIgnoreGuard(root);
    // Include the original entry path even if tsserver canonicalized an alias.
    for (const file of new Set([session.absolutePath, ...files])) {
      const canonical = await fs.realpath(file);
      if (
        library &&
        path.dirname(canonical) === library &&
        /^lib\.[\w.]+\.d\.ts$/u.test(path.basename(canonical))
      ) {
        continue;
      }
      const requestedRoot = isWithinRoot(root, file) ? root : session.rootPath;
      if (!(isWithinRoot(requestedRoot, file) && isWithinRoot(root, canonical))) {
        throw new LspReadPolicyError();
      }
      await assertNotAgentIgnored({
        canonicalAbsolutePath: canonical,
        canonicalRootPath: root,
        guard,
        relativePath: path.relative(requestedRoot, file).split(path.sep).join('/'),
      });
    }
  } catch {
    // Never echo a server error: it can itself contain a private source line.
    throw new LspReadPolicyError();
  }
}

/** Called under the root's operation lock. Open buffers are scoped to one
 * request, so they cannot shadow later disk edits, renames or deletions. Ask
 * the existing tsserver owner to reload closed inputs before analysing, rather
 * than adding another watcher or relying on its debounced filesystem events. */
export async function withLspDocument<T>(
  session: DocumentSession,
  task: (uri: string) => Promise<T>
): Promise<T> {
  const uri = pathToFileURL(session.absolutePath).href;
  try {
    await session.connection.sendNotification('textDocument/didOpen', {
      textDocument: { languageId: session.languageId, text: session.content, uri, version: 1 },
    });
    await tsserverRequest(session.connection, 'reloadProjects', {}, false);
    await assertProjectReadable(session);
    const result = await task(uri);
    // Recheck after asynchronous analysis: a rule tightened during a query
    // must not release content captured before the change.
    await assertProjectReadable(session);
    return result;
  } finally {
    await session.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
  }
}
