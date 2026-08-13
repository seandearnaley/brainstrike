#!/usr/bin/env node
/**
 * BST-1251 example Stop hook: grade the run's final answer against the armed
 * pilot task and emit a `brainstrikeRunVerdict` line (run-outcome source
 * 'hook'). Documented example for hook-driven verdicts (BST-1250 deliverable).
 *
 * Usage (in hooks.json): `node <abs>/verdict-hook.mjs <abs-state-dir>`
 *
 * The driver arms one task per run by writing `<state-dir>/current-task.json`:
 *   { "armed": true, "taskId": "t01", "threadId": "<thread>", "answerPatterns": ["..."] }
 *
 * Grading contract (see bst-1251-tasks.json): the assistant is instructed to
 * end its reply with one `ANSWER: <repo-relative-path>` line; the LAST such
 * line must match every answerPattern (case-insensitive). Not armed, a
 * different thread, or any unreadable input → exit 0 with NO verdict line, so
 * this hook can never mislabel unrelated runs.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const stateDir = process.argv[2];
if (!stateDir) {
  process.exit(0);
}

let stateRaw;
try {
  stateRaw = readFileSync(path.join(stateDir, 'current-task.json'), 'utf8');
} catch {
  process.exit(0);
}
const state = readJson(stateRaw);
if (!(state && state.armed === true && typeof state.taskId === 'string')) {
  process.exit(0);
}

let stdinRaw;
try {
  stdinRaw = readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}
const stdin = readJson(stdinRaw);
if (stdin?.hook_event_name !== 'Stop') {
  process.exit(0);
}
if (typeof state.threadId === 'string' && stdin.session_id !== state.threadId) {
  // Another thread finished while a task was armed; never grade it.
  process.exit(0);
}

function grade() {
  if (stdin.stop_reason !== 'complete') {
    return {
      detail: `${state.taskId}: stop_reason=${String(stdin.stop_reason)}`,
      verdict: 'failed',
    };
  }
  const message = typeof stdin.assistant_message === 'string' ? stdin.assistant_message : '';
  const answerLines = message.match(/^\s*ANSWER:.*$/gim);
  if (!answerLines || answerLines.length === 0) {
    return { detail: `${state.taskId}: no ANSWER line`, verdict: 'failed' };
  }
  const last = answerLines.at(-1);
  const patterns = Array.isArray(state.answerPatterns) ? state.answerPatterns : [];
  const missing = patterns
    .map((pattern, index) => (new RegExp(pattern, 'i').test(last) ? null : index))
    .filter((index) => index !== null);
  if (patterns.length === 0) {
    return { detail: `${state.taskId}: no answerPatterns armed`, verdict: 'failed' };
  }
  if (missing.length > 0) {
    return {
      detail: `${state.taskId}: missing pattern(s) ${missing.join(',')}`,
      verdict: 'failed',
    };
  }
  return { detail: state.taskId, verdict: 'succeeded' };
}

const { detail, verdict } = grade();
try {
  appendFileSync(
    path.join(stateDir, 'verdicts.jsonl'),
    `${JSON.stringify({
      at: new Date().toISOString(),
      detail,
      taskId: state.taskId,
      threadId: stdin.session_id,
      verdict,
    })}\n`
  );
} catch {
  // The verdict line below is the source of truth; the log is best-effort.
}
process.stdout.write(`${JSON.stringify({ brainstrikeRunVerdict: { detail, verdict } })}\n`);
