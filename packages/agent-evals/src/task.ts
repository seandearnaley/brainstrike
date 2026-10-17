/**
 * The eval task format (docs/agents/agent-evals.md). A task is a folder,
 * `tasks/<id>/`: `task.json`, the starting workspace in `repo/`, an optional
 * hidden verifier in `verify/` the agent never sees, an optional scripted-mode
 * `script.json` and an optional provider cassette.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { wireResultDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Result, Schema } from 'effect';

const Text = Schema.String.check(Schema.isMinCodePoints(1));

export const EvalTaskSchema = Schema.Struct({
  /** A provider cassette, relative to the task folder: replay mode serves it. */
  cassette: Schema.optionalKey(Text),
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)),
  /** The canonical `provider::model` replay and live modes run. */
  model: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+::\S+$/u)),
  prompt: Text,
  /** How long the agent run may take, approvals included; the verifier is timed apart. */
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Text,
  /** Runs in the finished workspace with the hidden verifier copied in; exit 0 passes. */
  verify: Schema.Struct({ command: Schema.Array(Text).check(Schema.isMinLength(1)) }),
});
export type EvalTask = typeof EvalTaskSchema.Type;

/** Scripted mode: the tool calls the scripted model makes, one per step, before it answers. */
export const EvalScriptSchema = Schema.Struct({
  calls: Schema.Array(Schema.Struct({ input: Schema.MutableJson, toolId: Text })).check(
    Schema.isMinLength(1)
  ),
});
export type EvalScript = typeof EvalScriptSchema.Type;

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
