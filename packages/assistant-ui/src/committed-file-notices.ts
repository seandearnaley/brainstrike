import {
  type AssistantRunEvent,
  describeHookSkip,
  describeReferencedFileFailure,
  ReferencedFileFailureSchema,
} from '@brainstrike/assistant-contract';
import { readHookSkips } from './committed-host-event-readers';

interface FileNotice {
  event: Pick<AssistantRunEvent, 'detail' | 'kind' | 'label' | 'metadata' | 'status'>;
  key: string;
}
/** Both file notice kinds use the existing committed row address, never a new durable ID. */
export function committedFileNotices(
  event: Readonly<Record<string, unknown>>
): FileNotice[] | undefined {
  if (event['type'] === 'references.unavailable') {
    return ReferencedFileFailureSchema.array()
      .min(1)
      .parse(event['files'])
      .map((file, index) => ({
        event: {
          ...describeReferencedFileFailure(file),
          kind: 'reference.unavailable',
          metadata: { code: file.failure.code, path: file.path, rootId: file.rootId },
          status: 'failed',
        },
        key: `reference:${index}`,
      }));
  }
  if (event['type'] !== 'hooks.skipped') {
    return;
  }
  return readHookSkips(event).map((skip, index) => ({
    event: {
      ...describeHookSkip(skip, 'review it in Settings > Hooks'),
      kind: 'hook.notice',
      metadata: { path: skip.path, reason: skip.reason },
      status: 'failed',
    },
    key: `hook-skip:${index}`,
  }));
}
