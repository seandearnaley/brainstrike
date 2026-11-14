/**
 * The eval task format (docs/agents/agent-evals.md). A task is a folder,
 * `tasks/<id>/`: `task.json`, the starting workspace in `repo/`, an optional
 * hidden verifier in `verify/` the agent never sees, an optional scripted-mode
 * `script.json` and an optional provider cassette. A task may continue its
 * thread with follow-up turns, so one long enough crosses a compaction.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { wireResultDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Option, Predicate, Result, Schema } from 'effect';

const Text = Schema.String.check(Schema.isMinCodePoints(1));
const Positive = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * A later turn on the task's thread. A `probe` makes the turn a question about
 * earlier turns: its answer must state every fact, so a turn the model can no
 * longer see (compacted away) fails by what the answer leaves out.
 */
const EvalFollowUp = Schema.Struct({
  probe: Schema.optionalKey(
    Schema.Struct({ facts: Schema.Array(Text).check(Schema.isMinLength(1)) })
  ),
  prompt: Text,
});
export type EvalFollowUp = typeof EvalFollowUp.Type;

export const EvalTaskSchema = Schema.Struct({
  /** A provider cassette, relative to the task folder: replay mode serves it. */
  cassette: Schema.optionalKey(Text),
  /**
   * Behaviour the committed log must show beyond the verifier's file checks:
   * `parallelCalls` names a tool the model must call at least `atLeast` times
   * in one step, so a parallel-read task fails when the reads arrive apart.
   * `compactions` is how many compactions the thread must commit, so a task
   * meant to measure them fails when its turns never reach the trigger; its
   * `kind` holds every one to that kind, so a task meant to measure a summary
   * fails when its thread is trimmed instead (a trim is deterministic).
   */
  expect: Schema.optionalKey(
    Schema.Struct({
      compactions: Schema.optionalKey(
        Schema.Struct({
          atLeast: Positive,
          kind: Schema.optionalKey(Schema.Literals(['agentic', 'deterministic'])),
        })
      ),
      parallelCalls: Schema.optionalKey(
        Schema.Struct({
          atLeast: Schema.Int.check(Schema.isGreaterThan(1)),
          toolId: Text,
        })
      ),
    })
  ),
  /** The turns after `prompt`, each run on the same thread once the one before completed. */
  followUps: Schema.optionalKey(Schema.Array(EvalFollowUp).check(Schema.isMinLength(1))),
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)),
  /**
   * Pins every run's input budget below the model's own, so a small workspace
   * crosses the compaction trigger for a fraction of a full window's tokens.
   */
  inputTokenLimit: Schema.optionalKey(Positive),
  /** The canonical `provider::model` replay and live modes run. */
  model: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+::\S+$/u)),
  prompt: Text,
  /** How long the agent run may take, approvals included; the verifier is timed apart. */
  timeoutMs: Positive,
  title: Text,
  /** Runs in the finished workspace with the hidden verifier copied in; exit 0 passes. */
  verify: Schema.Struct({ command: Schema.Array(Text).check(Schema.isMinLength(1)) }),
});
export type EvalTask = typeof EvalTaskSchema.Type;

const EvalScriptCall = Schema.Struct({ input: Schema.MutableJson, toolId: Text });

const EvalScriptStep = Schema.Union([
  EvalScriptCall,
  Schema.Struct({ parallel: Schema.Array(EvalScriptCall).check(Schema.isMinLength(2)) }),
]);

/**
 * Scripted mode: the model's steps before it answers. Each entry is one step:
 * a single call, or `{ parallel: [...] }` for calls made in one response.
 * `answer` is the first turn's final text; `followUps` scripts each later turn
 * in the task's order; `summary` is what the model answers a compaction's
 * summarizer with.
 */
export const EvalScriptSchema = Schema.Struct({
  answer: Schema.optionalKey(Text),
  calls: Schema.Array(EvalScriptStep).check(Schema.isMinLength(1)),
  followUps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        answer: Schema.optionalKey(Text),
        calls: Schema.optionalKey(Schema.Array(EvalScriptStep)),
      })
    ).check(Schema.isMinLength(1))
  ),
  summary: Schema.optionalKey(Text),
});
export type EvalScript = typeof EvalScriptSchema.Type;

type ScriptCall = typeof EvalScriptCall.Type;

const decodeRepeat = Schema.decodeUnknownOption(
  Schema.Struct({
    $repeat: Schema.Struct({ text: Text, times: Positive }),
  }),
  { onExcessProperty: 'error' }
);

/**
 * A script input as the model sends it. `{ "$repeat": { text, times } }`
 * anywhere in it stands for `text` repeated, so a script can make a call large
 * enough to fill a context window without holding the bytes.
 */
function expandInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(expandInput);
  }
  if (!Predicate.isObject(value)) {
    return value;
  }
  const repeat = Option.getOrUndefined(decodeRepeat(value));
  return repeat
    ? repeat.$repeat.text.repeat(repeat.$repeat.times)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandInput(item)]));
}

function steps(calls: readonly (typeof EvalScriptStep.Type)[]): ScriptCall[][] {
  return calls
    .map((entry) => ('parallel' in entry ? [...entry.parallel] : [entry]))
    .map((step) =>
      step.map((call) => ({ ...call, input: expandInput(call.input) as ScriptCall['input'] }))
    );
}

/** A script's first-turn steps, each the calls made in one model response. */
export function scriptSteps(script: EvalScript): ScriptCall[][] {
  return steps(script.calls);
}

export interface EvalScriptTurn {
  /** The turn's final text; the scripted model's own when absent. */
  readonly answer?: string;
  readonly steps: ScriptCall[][];
}

/** A script by turn: the task's prompt first, then each follow-up in order. */
export function scriptTurns(script: EvalScript): EvalScriptTurn[] {
  const turn = (calls: readonly (typeof EvalScriptStep.Type)[], answer?: string) => ({
    ...(answer === undefined ? {} : { answer }),
    steps: steps(calls),
  });
  return [
    turn(script.calls, script.answer),
    ...(script.followUps ?? []).map((followUp) => turn(followUp.calls ?? [], followUp.answer)),
  ];
}

/** A strict decoder whose refusal names the file it read. */
export function fileDecoder<S extends Schema.ConstraintDecoder<unknown>>(schema: S, kind: string) {
  const decode = wireResultDecoder(schema, { errors: 'all', onExcessProperty: 'error' });
  return (value: unknown, source: string): S['Type'] => {
    const result = decode(value);
    if (Result.isFailure(result)) {
      throw new Error(`${source} is not a valid ${kind}: ${result.failure.message}`, {
        cause: result.failure,
      });
    }
    return result.success;
  };
}

export const decodeEvalTask = fileDecoder(EvalTaskSchema, 'eval task');
export const decodeEvalScript = fileDecoder(EvalScriptSchema, 'eval script');

export interface LoadedEvalTask {
  readonly cassettePath?: string;
  readonly dir: string;
  readonly repoDir: string;
  readonly script?: EvalScript;
  readonly task: EvalTask;
  readonly verifyDir?: string;
}

async function kindOf(path: string): Promise<'directory' | 'file' | undefined> {
  try {
    const found = await stat(path);
    return found.isDirectory() ? 'directory' : 'file';
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw cause;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** One task folder; its name is the task's id. */
export async function loadEvalTask(dir: string): Promise<LoadedEvalTask> {
  const task = decodeEvalTask(await readJson(join(dir, 'task.json')), join(dir, 'task.json'));
  if (basename(dir) !== task.id) {
    throw new Error(`Task folder ${basename(dir)} must be named after its id, ${task.id}`);
  }
  const repoDir = join(dir, 'repo');
  if ((await kindOf(repoDir)) !== 'directory') {
    throw new Error(`${task.id} has no starting workspace at ${repoDir}`);
  }
  const cassettePath = task.cassette === undefined ? undefined : resolve(dir, task.cassette);
  if (cassettePath && (await kindOf(cassettePath)) !== 'file') {
    throw new Error(`${task.id} names cassette ${task.cassette}, which does not exist`);
  }
  const scriptPath = join(dir, 'script.json');
  const script =
    (await kindOf(scriptPath)) === 'file'
      ? decodeEvalScript(await readJson(scriptPath), scriptPath)
      : undefined;
  const turns = task.followUps?.length ?? 0;
  const scripted = script?.followUps?.length ?? 0;
  if (script && scripted !== turns) {
    throw new Error(
      `${task.id} has ${turns} follow-up turn(s), but ${scriptPath} has ${scripted}: scripted mode plays one per turn`
    );
  }
  if (script) {
    // The scripted model knows a turn only by the prompt that opens it.
    const prompts = [task.prompt, ...(task.followUps ?? []).map((followUp) => followUp.prompt)];
    for (const [index, prompt] of prompts.entries()) {
      const earlier = prompts.indexOf(prompt);
      if (earlier !== index) {
        throw new Error(
          `${task.id}: turns ${earlier + 1} and ${index + 1} open with the same prompt, so its script cannot tell them apart`
        );
      }
    }
  }
  const verifyDir = join(dir, 'verify');
  return {
    ...(cassettePath ? { cassettePath } : {}),
    dir,
    repoDir,
    ...(script ? { script } : {}),
    task,
    ...((await kindOf(verifyDir)) === 'directory' ? { verifyDir } : {}),
  };
}

/** Every task folder under `tasksDir`, by id. */
export async function loadEvalTasks(tasksDir: string): Promise<LoadedEvalTask[]> {
  const entries = await readdir(tasksDir, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return await Promise.all(dirs.map((name) => loadEvalTask(join(tasksDir, name))));
}
