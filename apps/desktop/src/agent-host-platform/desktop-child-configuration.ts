import { readCliWorkspaceRunInput } from '@brainstrike/agent-host/standalone-workspace-input';
import { refusalError } from '@brainstrike/assistant-contract';
import {
  type ChildModelTarget,
  childModelConfiguration,
} from '@brainstrike/assistant-contract/child-model';
import { Schema } from 'effect';
import { PlatformClientConfigurationSchema } from './platform-client-configuration';

const decodeIntent = Schema.decodeUnknownSync(PlatformClientConfigurationSchema, {
  errors: 'all',
  onExcessProperty: 'error',
});
const encodeIntent = Schema.encodeSync(PlatformClientConfigurationSchema);

/**
 * ADR-0037: the Send intent a delegated child on `target` is admitted with:
 * its parent run's own, with the child's model and the generation options the
 * shared builders make for its effort in place of the parent's. A run that
 * carries no desktop intent (a CLI workspace run, or one restart recovered)
 * cannot carry another model, and says so.
 */
export function desktopChildConfiguration(
  configuration: Readonly<Record<string, unknown>> | undefined,
  target: ChildModelTarget
): Record<string, Schema.MutableJson> {
  if (configuration === undefined || readCliWorkspaceRunInput(configuration)) {
    throw refusalError(
      'configuration',
      'delegation.model-unavailable',
      'This run carries no desktop settings to admit a subagent on another model with.',
      'Send the request from the desktop app.'
    );
  }
  // Decoded whole, as the Send capture decodes it, so the child's intent is as strict as any run's.
  return encodeIntent(
    decodeIntent({
      ...configuration,
      modelConfiguration: childModelConfiguration(target, undefined),
    })
  ) as Record<string, Schema.MutableJson>;
}
