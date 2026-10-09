import type { HostEvent } from '@brainstrike/agent-host/protocol';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';

const logger = createLogger('DesktopRunConfiguration');

/**
 * The parts of the desktop's durable run configuration that renderer views
 * read back: the Send intent's generation settings and focused root, and the
 * observer target admission resolved. The desktop admission writes it
 * (`desktopDurableConfiguration`); Core commits it on `run.started`.
 */
const DesktopRunConfigurationSchema = z.object({
  intent: z
    .object({
      modelConfiguration: z
        .object({ modelSettings: z.json().optional(), providerOptions: z.json().optional() })
        .optional(),
      selectionFolderId: z.string().min(1).optional(),
    })
    .optional(),
  memoryResolution: z.object({ observerTarget: z.string().min(1).nullable() }).optional(),
});
export type DesktopRunConfiguration = z.infer<typeof DesktopRunConfigurationSchema>;

/**
 * A run's committed desktop configuration; undefined for a run that committed
 * none. A configuration of another shape (another client's) reads as none and
 * is reported.
 */
export function readDesktopRunConfiguration(
  event: Extract<HostEvent, { type: 'run.started' }>
): DesktopRunConfiguration | undefined {
  const configuration = event.snapshot?.configuration;
  if (configuration === undefined) {
    return;
  }
  const parsed = DesktopRunConfigurationSchema.safeParse(configuration);
  if (!parsed.success) {
    logger.warn('A host run committed a configuration this renderer cannot read', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
      runId: event.runId,
    });
    return;
  }
  return parsed.data;
}
