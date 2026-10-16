import { z } from 'zod';

const RoleSchema = z.object({ role: z.string() });
const AssistantContentSchema = z.object({
  content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]),
});
const TextPartSchema = z.object({ text: z.string(), type: z.literal('text') });

/**
 * The answer in a run's committed model messages: the trimmed text of the last
 * assistant message, or undefined when these messages hold none, so a fold
 * over a run's `model.step` events keeps the last one it saw. The one rule for
 * a child's answer, wherever its log is read: the host's delegation result and
 * the renderer's delegation card both report a completed child with an empty
 * answer as `no-answer`.
 */
export function hostAnswerText(messages: readonly unknown[]): string | undefined {
  const last = messages.findLast((message) => RoleSchema.parse(message).role === 'assistant');
  if (last === undefined) {
    return;
  }
  const { content } = AssistantContentSchema.parse(last);
  if (typeof content === 'string') {
    return content.trim();
  }
  return content
    .flatMap((part) => (part.type === 'text' ? [TextPartSchema.parse(part).text] : []))
    .join('')
    .trim();
}
