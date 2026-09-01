#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const fail = () => {
  process.stderr.write('Packaged MCP OAuth browser fixture failed\n');
  process.exitCode = 1;
};

try {
  const [rawUrl, ...unexpected] = process.argv.slice(2);
  if (rawUrl === undefined || unexpected.length !== 0) {
    throw new Error('Expected one authorization URL');
  }
  const authorizationUrl = new URL(rawUrl);
  if (authorizationUrl.protocol !== 'http:' || authorizationUrl.hostname !== '127.0.0.1') {
    throw new Error('Expected a loopback authorization URL');
  }
  const stateFile = process.env['BRAINSTRIKE_MCP_OAUTH_BROWSER_STATE_FILE'];
  if (stateFile === undefined || !path.isAbsolute(stateFile)) {
    throw new Error('Expected an absolute browser state file');
  }
  let firstAttempt = false;
  try {
    await writeFile(stateFile, '', { flag: 'wx', mode: 0o600 });
    firstAttempt = true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }
  const authorization = await fetch(authorizationUrl, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (authorization.status !== 302) {
    throw new Error('Authorization endpoint did not redirect');
  }
  await authorization.body?.cancel();
  if (!firstAttempt) {
    const rawCallbackUrl = authorization.headers.get('location');
    if (rawCallbackUrl === null) {
      throw new Error('Authorization callback is missing');
    }
    const callbackUrl = new URL(rawCallbackUrl);
    if (callbackUrl.protocol !== 'http:' || callbackUrl.hostname !== '127.0.0.1') {
      throw new Error('Expected a loopback callback URL');
    }
    const callback = await fetch(callbackUrl, { signal: AbortSignal.timeout(30_000) });
    if (!callback.ok) {
      throw new Error('Authorization callback failed');
    }
    await callback.body?.cancel();
  }
} catch {
  fail();
}
