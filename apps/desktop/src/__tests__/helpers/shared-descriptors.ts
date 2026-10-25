import { execFileSync } from 'node:child_process';
import { readdirSync, readlinkSync } from 'node:fs';

// Devices every process opens for itself; sharing one says nothing about inheritance.
const DEVICES = /^\/dev\/(?:null|zero|u?random|tty|ptmx|pts\/)/u;

/** What each descriptor above stderr names: a path, or a pipe or socket by inode. */
function descriptorTargets(pid: number): string[] {
  if (process.platform === 'darwin') {
    // lsof -F prints `f<fd>` then `n<name>` per descriptor.
    const fields = execFileSync('lsof', ['-a', '-p', String(pid), '-d', '3-9999', '-Fn'], {
      encoding: 'utf8',
    });
    return fields
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1));
  }
  const directory = `/proc/${pid}/fd`;
  return readdirSync(directory)
    .filter((fd) => Number(fd) > 2)
    .flatMap((fd) => {
      try {
        return [readlinkSync(`${directory}/${fd}`)];
      } catch {
        // Closed between the listing and the read.
        return [];
      }
    });
}

/**
 * The files, pipes and sockets `child` holds above its stdio that `parent` holds too: what
 * `child` inherited instead of opening. Files under `runtime`, the directory of the binary
 * both run, do not count: every Electron process opens its own V8 snapshot and ICU data.
 * POSIX only; Windows creates handles non-inheritable.
 */
export function sharedDescriptors(parent: number, child: number, runtime: string): string[] {
  const held = new Set(descriptorTargets(parent));
  const shareable = (target: string) =>
    (target.startsWith('/') && !DEVICES.test(target) && !target.startsWith(runtime)) ||
    /^(?:pipe|socket):\[/u.test(target);
  return [...new Set(descriptorTargets(child))].filter(
    (target) => shareable(target) && held.has(target)
  );
}
