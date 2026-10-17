import { createLogger } from '@brainstrike/logging';
import { Schema, SchemaIssue } from 'effect';
import type { HostEvent } from './protocol.js';

const logger = createLogger('DesktopRunConfiguration');
/**
 * The parts of the desktop's durable run configuration that renderer views
 * read back: the Send intent's generation settings and focused root. The
 * desktop admission writes it
 * (`desktopDurableConfiguration`); Core commits it on `run.started`.
 */
const DesktopRunConfigurationSchema = Schema.Struct({
  intent: Schema.optional(
    Schema.Struct({
      modelConfiguration: Schema.optional(
        Schema.Struct({
          modelSettings: Schema.optional(Schema.MutableJson),
          providerOptions: Schema.optional(Schema.MutableJson),
        })
      ),
      selectionFolderId: Schema.optional(Schema.String.check(Schema.isMinCodePoints(1))),
    })
  ),
});
export type DesktopRunConfiguration = (typeof DesktopRunConfigurationSchema)['Type'];
/**
 * A run's committed desktop configuration; undefined for a run that committed
 * none. A configuration of another shape (another client's) reads as none and
 * is reported.
 */
export function readDesktopRunConfiguration(
  event: Extract<
    HostEvent,
    {
      type: 'run.started';
    }
  >
): DesktopRunConfiguration | undefined {
  const configuration = event.snapshot?.configuration;
  if (configuration === undefined) {
    return;
  }
  const parsed = Schema.decodeUnknownResult(DesktopRunConfigurationSchema)(configuration);
  if (!(parsed._tag === 'Success')) {
    logger.warn('A host run committed a configuration this renderer cannot read', {
      issues: SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue).issues.map(
        (issue) =>
          (issue.path ?? [])
            .map((segment) => (typeof segment === 'object' ? segment.key : segment))
            .join('.')
      ),
      runId: event.runId,
    });
    return;
  }
  return parsed.success;
}
