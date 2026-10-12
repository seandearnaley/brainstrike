import type { ModelMessage, TextStreamPart, ToolSet } from 'ai';

type ModelStreamPart = Extract<
  TextStreamPart<ToolSet>,
  {
    type:
      | 'reasoning-delta'
      | 'reasoning-end'
      | 'reasoning-start'
      | 'text-delta'
      | 'text-end'
      | 'text-start';
  }
>;

/**
 * Whether a fullStream part is the model's text or reasoning stream. It goes to
 * subscribers as uncommitted `run/telemetry`; the step's committed `model.step`
 * messages own the text (ADR-0011 amendment). Step and tool parts still commit.
 */
export function isModelStreamTelemetry(chunk: TextStreamPart<ToolSet>): chunk is ModelStreamPart {
  switch (chunk.type) {
    case 'text-start':
    case 'text-delta':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-delta':
    case 'reasoning-end':
      return true;
    default:
      return false;
  }
}

/**
 * The open step's text and reasoning as Core observed it, in stream order, so a
 * user's Stop mid-step can commit the partial reply, as legacy kept it. A step
 * whose `model.step` committed owns its text and is cleared.
 */
export class HostStepPartial {
  private readonly parts = new Map<string, { type: 'reasoning' | 'text'; text: string }>();

  observe(chunk: ModelStreamPart): void {
    if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') {
      return;
    }
    const type = chunk.type === 'text-delta' ? 'text' : 'reasoning';
    const key = `${type}:${chunk.id}`;
    const part = this.parts.get(key) ?? { text: '', type };
    this.parts.set(key, { ...part, text: part.text + chunk.text });
  }

  clear(): void {
    this.parts.clear();
  }

  /** The observed partial assistant message, or undefined when the step streamed no text. */
  message(): ModelMessage | undefined {
    const content = [...this.parts.values()].filter((part) => part.text.length > 0);
    return content.length > 0 ? { content, role: 'assistant' } : undefined;
  }
}
