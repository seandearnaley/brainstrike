import { createRequire } from 'node:module';
import type { CommandJob } from '@brainstrike/windows-job-native';

/**
 * Windows: a kill-on-close Job Main holds for one host it forked, with the host `pid` assigned by
 * the creation time read now, while it runs (undefined if it has already exited). Main itself
 * stays outside it, so what Main opens for the user (a browser, an editor) never dies with Main.
 * If Main's process ends by any means, its handle closes and the OS ends the host; the host's own
 * kill-on-close Job then ends everything the host started, whether the host made that Job before
 * or after this assignment. POSIX has no such object: undefined there.
 */
export function holdHostProcessJob(pid: number | undefined): CommandJob | undefined {
  if (process.platform !== 'win32' || pid === undefined) {
    return undefined;
  }
  const native = createRequire(import.meta.url)('@brainstrike/windows-job-native') as Pick<
    typeof import('@brainstrike/windows-job-native'),
    'createCommandJob' | 'getProcessCreationTime'
  >;
  const creationTime = native.getProcessCreationTime(pid);
  if (creationTime === null) {
    return undefined;
  }
  const job = native.createCommandJob();
  job.assign({ creationTime, pid });
  return job;
}

/** After the host's exit is joined: end what remains of its process tree, then release the Job. */
export async function releaseHostProcessJob(job: CommandJob | undefined): Promise<void> {
  if (job) {
    await job.terminateAndWait(1);
    job.close();
  }
}
