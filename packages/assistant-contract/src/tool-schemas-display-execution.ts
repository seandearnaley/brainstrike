/**
 * Execution Tool Schema Display Metadata
 *
 * Browser-safe parameter definitions for native execution tools.
 */

import type { NativeToolId } from './native-tool-catalog.js';
import type { ToolSchemaDisplay } from './tool-schemas-display-types.js';

export const EXECUTION_TOOL_SCHEMAS = {
  'brainstrike.executeCommand': {
    description:
      "Run an arbitrary shell command on the user's machine (e.g. pnpm test, git status, a build). This is ARBITRARY COMMAND EXECUTION with NO sandbox: a command can read or change anything the user can. By default the call suspends for the user's per-call approval before running (execute resolves to 'ask'); the user can let it run unprompted or deny it entirely. The command starts in the selected workspace root (pin it elsewhere with cwd, which must still resolve inside an open folder) and runs in the user's shell. On timeout or cancellation the ENTIRE process tree is killed so nothing is left running. Prefer non-destructive commands.",
    parameters: [
      {
        description:
          'The shell command line, passed verbatim to the shell as `-c command`. Arbitrary execution, no sandbox.',
        maxLength: 10_000,
        minLength: 1,
        name: 'command',
        required: true,
        type: 'string',
      },
      {
        description:
          'Optional folder name or id to choose which open folder to start in (omit when only one is open)',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        description:
          'Optional start directory (absolute or relative to the root) that MUST resolve inside an open folder. Defaults to the workspace root.',
        name: 'cwd',
        required: false,
        type: 'string',
      },
      {
        default: 120_000,
        description:
          'Kill the whole process tree after this many milliseconds; the result reports timedOut: true',
        max: 600_000,
        min: 1,
        name: 'timeoutMs',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'exitCode (null when killed by signal), the terminating signal, a budget-bounded tail of stdout and stderr (truncated flag + hint when trimmed), durationMs, timedOut, and the resolved cwd',
    toolId: 'brainstrike.executeCommand',
  },

  'brainstrike.inspectCommandSessions': {
    description:
      'Inspect persistent PTY sessions owned by one open workspace root. List and read are bounded pages; sensitive command-session input and output are redacted from durable history.',
    parameters: [
      {
        description:
          'Exactly one operation: {action:"list", offset?}, or {action:"read", sessionId, cursor?}.',
        name: 'operation',
        required: true,
        type: 'object',
      },
      {
        description: 'Optional folder name or durable id; omit when only one folder is open.',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'For list: a compact page with totalSessions and nextOffset when truncated. For read: bounded output, nextCursor, availableEndCursor, remaining count, retained buffer boundary, and explicit replay-gap state.',
    toolId: 'brainstrike.inspectCommandSessions',
  },

  'brainstrike.manageCommandSession': {
    description:
      'Start, write to, stop, or remove a persistent workspace PTY. Use for servers and interactive commands that must survive one tool call. Arbitrary execution, no sandbox, approval required by default.',
    parameters: [
      {
        description:
          'Exactly one operation: {action:"start", command, cwd?, cols?, rows?}, {action:"write", sessionId, data}, {action:"stop", sessionId}, or {action:"remove", sessionId}.',
        name: 'operation',
        required: true,
        type: 'object',
      },
      {
        description: 'Optional folder name or durable id; omit when only one folder is open.',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Typed session state for start/stop/write, or an explicit removed result. Failures distinguish invalid input, unavailable roots, unknown/cross-root sessions, exited sessions, startup failure, and stop failure.',
    toolId: 'brainstrike.manageCommandSession',
  },

  'brainstrike.readToolOutputArtifact': {
    description:
      'Page or search the next bounded UTF-8 slice of an oversized tool result. Pass the prior cursor unchanged.',
    parameters: [
      {
        description: 'Case-sensitive search (default false).',
        name: 'caseSensitive',
        required: false,
        type: 'boolean',
      },
      {
        description:
          'Exact opaque continuation cursor from the previous result. Copy byte-for-byte; never decode, pad, edit, or recreate it.',
        name: 'cursor',
        required: true,
        type: 'string',
      },
      {
        description: 'Treat pattern as JavaScript regex (default false).',
        name: 'isRegex',
        required: false,
        type: 'boolean',
      },
      {
        description: 'Optional UTF-8 source-byte page target (4-8000; default 6000).',
        max: 8000,
        min: 4,
        name: 'maxBytes',
        required: false,
        type: 'number',
      },
      {
        description: 'Literal or JavaScript regex pattern for the next artifact slice.',
        maxLength: 2000,
        minLength: 1,
        name: 'pattern',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'A contiguous page, or compact grep-style matching lines with continuation whenever scanning or rendering is limited.',
    toolId: 'brainstrike.readToolOutputArtifact',
  },

  'brainstrike.runPython': {
    description:
      "Run Python source you write, inside an OS-level sandbox on the user's machine. Network is CLOSED unless you list exact domains in allowedDomains — and even then the user must explicitly approve those domains for THAT run (there is no standing grant; a deny returns network_denied so you can rewrite the script to work offline). Writes are confined to a fresh per-call scratch directory deleted when the call finishes, so nothing it writes persists. Reads are not restricted, so treat anything it reads as sensitive. Requires approval (execute-risk). Use it for computation, parsing, and data wrangling; stdout and stderr come back to you.",
    parameters: [
      {
        description:
          'Exact domains the script may reach (e.g. "pypi.org", "*.example.com"). Omit for no network. A bare "*" is not expressible. Each listed domain requires explicit per-run user approval.',
        name: 'allowedDomains',
        required: false,
        type: 'array',
      },
      {
        description:
          'Python source to execute. Runs as a script, not a REPL — print() to return values.',
        maxLength: 1_000_000,
        minLength: 1,
        name: 'code',
        required: true,
        type: 'string',
      },
      {
        description: 'Wall-clock limit in ms (default 30000, max 600000)',
        name: 'timeoutMs',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'A discriminated result: completed (exitCode, stdout, stderr, per-stream omitted byte counts), timed_out, killed, cancelled (partial output), network_denied (deniedDomains — rewrite offline), declined (the user did not approve the run), or unavailable (no sandbox on this machine).',
    toolId: 'brainstrike.runPython',
  },

  'brainstrike.runSkillScript': {
    description:
      'Run one bundled script from an activated Agent Skill using trusted resolution, structured arguments, and an explicit mounted working root. Requires approval.',
    parameters: [
      {
        description: 'Activated installed skill name',
        name: 'skillName',
        required: true,
        type: 'string',
      },
      {
        description: 'Canonical skill-root-relative scripts/... path',
        name: 'scriptPath',
        required: true,
        type: 'string',
      },
      {
        description: 'Interpreter required by the bundled script',
        enumValues: ['bash', 'node', 'python3'],
        name: 'runtime',
        required: true,
        type: 'enum',
      },
      {
        arrayItemType: 'string',
        description: 'Structured arguments passed directly to the script',
        max: 64,
        name: 'args',
        required: false,
        type: 'array',
      },
      {
        description: 'Explicit mounted folder name or durable id',
        name: 'root',
        required: true,
        type: 'string',
      },
      {
        description: 'Explicit root-relative working directory',
        name: 'cwd',
        required: true,
        type: 'string',
      },
      {
        description: 'Process-tree timeout ms (default 120000, max 600000)',
        max: 600_000,
        min: 1,
        name: 'timeoutMs',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'Resolved skill identity/source tier, mounted root, exit status, bounded stdout/stderr tail, duration, timeout, and truncation state',
    toolId: 'brainstrike.runSkillScript',
  },

  skill: {
    description:
      "Activate an Agent Skill by name: loads the skill's full SKILL.md instructions into the conversation, plus a listing of its bundled reference/script/asset files. Read-only.",
    parameters: [
      {
        description:
          'The skill name from the available-skills list (or its directory path when two skills share a name).',
        name: 'name',
        required: true,
        type: 'string',
      },
    ],
    returns:
      'The skill instructions (SKILL.md body) followed by listings of its references/, scripts/, and assets/ files; oversized instructions are truncated with an honest note.',
    toolId: 'skill',
  },
} satisfies Partial<Record<NativeToolId, ToolSchemaDisplay>>;
