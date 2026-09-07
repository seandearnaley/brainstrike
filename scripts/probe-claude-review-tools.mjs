// Opt-in behavioral verification against the CLI version installed by the pinned action.
// Usage: node scripts/probe-claude-review-tools.mjs /absolute/path/to/claude
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeReviewToolArgs } from './claude-review.mjs';

export async function main({ claudeBinary: binary }) {
  assert.ok(binary && path.isAbsolute(binary), 'Supply the absolute path to Claude Code 2.1.261.');
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(version, '2.1.261 (Claude Code)', 'Use the version installed by the pinned action.');
  const directory = mkdtempSync(path.join(tmpdir(), 'claude-review-tools-'));
  const workspace = path.join(directory, 'workspace');
  const captureDirectory = path.join(directory, 'capture');
  const outside = path.join(directory, 'outside');
  for (const created of [workspace, captureDirectory, outside]) {
    mkdirSync(created, { recursive: true });
  }
  const privateData = 'PRIVATE_FILE_MUST_NOT_BE_READ';
  const privateFile = path.join(outside, 'private.txt');
  writeFileSync(privateFile, privateData);
  // The diff the model is supposed to reach, and the only file it should reach.
  const capturedData = 'diff --git a/x b/x\n+CAPTURED_DIFF_MUST_BE_READ\n';
  const capturedFile = path.join(captureDirectory, 'captured-diff.txt');
  writeFileSync(capturedFile, capturedData);
  const requests = [];
  const result = { reviewed: true };
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    if (!request.url.startsWith('/v1/messages')) {
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
      return;
    }
    const data = JSON.parse(body);
    requests.push(data);
    const content =
      requests.length === 1
        ? {
            id: 'toolu_bash',
            input: { command: `cat ${privateFile}` },
            name: 'Bash',
            type: 'tool_use',
          }
        : requests.length === 2
          ? {
              id: 'toolu_outside',
              input: { file_path: privateFile },
              name: 'Read',
              type: 'tool_use',
            }
          : requests.length === 3
            ? {
                id: 'toolu_capture',
                input: { file_path: capturedFile },
                name: 'Read',
                type: 'tool_use',
              }
            : { id: 'toolu_result', input: result, name: 'StructuredOutput', type: 'tool_use' };
    const message = {
      content: [],
      id: `msg_${requests.length}`,
      model: 'claude-opus-5',
      role: 'assistant',
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    response.setHeader('Content-Type', 'text/event-stream');
    const emit = (event, payload) =>
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    emit('message_start', { message, type: 'message_start' });
    emit('content_block_start', {
      content_block: { ...content, input: {} },
      index: 0,
      type: 'content_block_start',
    });
    emit('content_block_delta', {
      delta: { partial_json: JSON.stringify(content.input), type: 'input_json_delta' },
      index: 0,
      type: 'content_block_delta',
    });
    emit('content_block_stop', { index: 0, type: 'content_block_stop' });
    emit('message_delta', {
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      type: 'message_delta',
      usage: { output_tokens: 10 },
    });
    emit('message_stop', { type: 'message_stop' });
    response.end();
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const child = spawn(
      binary,
      [
        '-p',
        'Review only this supplied text and return the requested structured result.',
        '--model',
        'claude-opus-5',
        '--max-turns',
        '6',
        ...claudeReviewToolArgs,
        '--add-dir',
        captureDirectory,
        '--json-schema',
        JSON.stringify({
          additionalProperties: false,
          properties: { reviewed: { type: 'boolean' } },
          required: ['reviewed'],
          type: 'object',
        }),
        '--output-format',
        'json',
      ],
      {
        cwd: workspace,
        // Fake credential and localhost API only. Never inherit real provider credentials.
        env: {
          ANTHROPIC_API_KEY: 'local-test-key',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CONFIG_DIR: directory,
          DISABLE_AUTOUPDATER: '1',
          HOME: directory,
          PATH: process.env.PATH,
          SHELL: process.env.SHELL,
          USER: process.env.USER,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const deadline = setTimeout(() => child.kill('SIGTERM'), 30_000);
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    }).finally(() => clearTimeout(deadline));
    assert.equal(code, 0, `CLI failed: ${stderr}\n${stdout}`);
    assert.equal(
      requests.length,
      4,
      'Expected Bash denied, out-of-grant Read denied, in-grant Read served, then completion.'
    );
    // Read is a capability the review now needs; Bash and everything else in the
    // built-in set must stay absent, because --tools is the only hard cap.
    for (const request of requests) {
      assert.deepEqual(request.tools.map((tool) => tool.name).sort(), ['Read', 'StructuredOutput']);
    }
    assert.match(JSON.stringify(requests[1].messages), /No such tool available: Bash/);
    // Read exists, so the boundary is now the directory grant rather than the
    // tool list: a path outside the working directory and the capture directory
    // must still fail, and its contents must never reach the model.
    assert.ok(
      !JSON.stringify(requests).includes(privateData),
      'Read must not serve a file outside the working and capture directories.'
    );
    // The positive half: the handoff must actually deliver the captured diff,
    // or the review would silently have nothing to review.
    assert.ok(
      JSON.stringify(requests[3].messages).includes('CAPTURED_DIFF_MUST_BE_READ'),
      'Read must serve the captured diff from the granted capture directory.'
    );
    assert.deepEqual(JSON.parse(stdout).structured_output, result);
    console.log(
      `${version}: Bash absent; out-of-grant read refused; captured diff served from the granted directory; only Read and StructuredOutput exposed; structured completion passed.`
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { force: true, recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main({ claudeBinary: process.argv[2] });
}
