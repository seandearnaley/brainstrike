// Opt-in behavioral verification against the CLI version installed by the pinned action.
// Usage: node scripts/probe-claude-review-tools.mjs /absolute/path/to/claude
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeReviewToolArgs } from './claude-review.mjs';

export async function main({ claudeBinary: binary }) {
  assert.ok(binary && path.isAbsolute(binary), 'Supply the absolute path to Claude Code 2.1.261.');
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(version, '2.1.261 (Claude Code)', 'Use the version the workflow pins.');
  const directory = mkdtempSync(path.join(tmpdir(), 'claude-review-tools-'));
  const privateData = 'PRIVATE_FILE_MUST_NOT_BE_READ';
  writeFileSync(path.join(directory, 'private.txt'), privateData);
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
    const first = requests.length === 1;
    const content = first
      ? {
          id: 'toolu_attempt',
          input: { command: `cat ${directory}/private.txt` },
          name: 'Bash',
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
    const promptFile = path.join(directory, 'prompt.txt');
    writeFileSync(
      promptFile,
      'Review only this supplied text and return the requested structured result.'
    );
    // Production streams the prompt from a file descriptor. Exercise that, not a
    // convenience string: passing it in argv here would test a path we do not ship.
    const promptFd = openSync(promptFile, 'r');
    const child = spawn(
      binary,
      [
        '-p',
        '--model',
        'claude-opus-5',
        '--max-turns',
        '3',
        ...claudeReviewToolArgs,
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
        cwd: directory,
        // Fake credential and localhost API only. Never inherit real provider credentials.
        env: {
          ANTHROPIC_API_KEY: 'local-test-key',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CONFIG_DIR: directory,
          DISABLE_AUTOUPDATER: '1',
          PATH: process.env.PATH,
          SHELL: process.env.SHELL,
          USER: process.env.USER,
        },
        stdio: [promptFd, 'pipe', 'pipe'],
      }
    );
    closeSync(promptFd);
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
      2,
      'Expected one denied tool call followed by structured completion.'
    );
    for (const request of requests) {
      assert.deepEqual(
        request.tools.map((tool) => tool.name),
        ['StructuredOutput']
      );
    }
    assert.match(JSON.stringify(requests[1].messages), /No such tool available: Bash/);
    assert.ok(
      !JSON.stringify(requests).includes(privateData),
      'The CLI must not read the private file.'
    );
    assert.deepEqual(JSON.parse(stdout).structured_output, result);
    // argv must carry no prompt text at all; the prompt reached the CLI on stdin.
    assert.ok(
      !JSON.stringify(process.argv).includes('Review only this supplied text'),
      'The prompt must never appear in an argument.'
    );
    console.log(
      `${version}: prompt delivered on stdin; Bash execution rejected; private file unread; only StructuredOutput exposed; structured completion passed.`
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
