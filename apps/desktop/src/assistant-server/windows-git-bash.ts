import fs from 'node:fs/promises';
import { win32 as path } from 'node:path';
import { ToolInputError } from '@brainstrike/assistant-contract';

function windowsGitRoots(environment: NodeJS.ProcessEnv): Set<string> {
  const roots = new Set<string>();
  for (const name of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    const directory = environment[name];
    if (directory && path.isAbsolute(directory)) {
      roots.add(path.join(directory, 'Git'));
    }
  }
  const local = environment['LOCALAPPDATA'];
  if (local && path.isAbsolute(local)) {
    roots.add(path.join(local, 'Programs', 'Git'));
  }
  for (const entry of (environment['PATH'] ?? environment['Path'] ?? '').split(';')) {
    const directory = entry.replace(/^"|"$/g, '');
    if (!path.isAbsolute(directory)) {
      continue;
    }
    const basename = path.basename(directory).toLowerCase();
    if (basename === 'cmd' || basename === 'bin') {
      roots.add(path.dirname(directory));
      if (path.basename(path.dirname(directory)).toLowerCase() === 'usr') {
        roots.add(path.dirname(path.dirname(directory)));
      }
    }
  }
  return roots;
}

/** Resolve Git for Windows explicitly: PATH's bash.exe can be the WSL launcher. */
export async function resolveWindowsGitBash(
  environment: NodeJS.ProcessEnv = process.env
): Promise<string> {
  for (const root of windowsGitRoots(environment)) {
    const executable = path.join(root, 'bin', 'bash.exe');
    try {
      const files = await Promise.all(
        [path.join(root, 'cmd', 'git.exe'), executable].map((file) => fs.stat(file))
      );
      if (files.every((file) => file.isFile())) {
        return executable;
      }
    } catch (cause) {
      if (!['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException).code ?? '')) {
        throw cause;
      }
    }
  }
  throw new ToolInputError(
    'The bash skill-script runtime requires Git for Windows. Install it in its standard location or add its cmd or bin directory to PATH.'
  );
}
