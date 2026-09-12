import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';

const logger = createLogger('MastraAgent');
const childInput = z.object({
  contents: z.string(),
  createdAt: z.iso.datetime(),
  id: z.string().min(1),
  metadata: z.object({ brainstrikeChildContinuation: z.string().trim().min(1) }),
});

/** Both projection paths recognize and validate the same native continuation signal. */
export function readChildContinuationUserMessage(
  data: unknown
): z.infer<typeof childInput> | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const metadata: unknown = Reflect.get(data, 'metadata');
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !Object.hasOwn(metadata, 'brainstrikeChildContinuation')
  ) {
    return undefined;
  }
  const parsed = childInput.safeParse(data);
  if (!parsed.success) {
    logger.warn('Malformed child continuation user message', {
      code: 'mastra_child_continuation_input_invalid',
    });
    throw new Error('Malformed child continuation user message.');
  }
  return parsed.data;
}
