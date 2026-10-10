import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Keep the production shell and source cwd; only the fixture program is portable. */
export function writeHookCommand(root: string, program: string): string {
  const script = join(root, `hook-${randomUUID()}.cjs`);
  writeFileSync(script, program, 'utf8');
  // Windows qualification uses a controlled, space-free TEMP path.
  return process.platform === 'win32' ? `node ${script}` : `node "${script}"`;
}

export function writeStdoutHook(root: string, stdout: unknown, exitCode = 0): string {
  return writeHookCommand(
    root,
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(stdout)}\n`)});\nprocess.exitCode = ${exitCode};\n`
  );
}
