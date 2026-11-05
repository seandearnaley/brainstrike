import { useMessagePartReasoning } from '@assistant-ui/react';
import { stripProviderCitationMarkers } from '@brainstrike/assistant-contract/citation-markers';

/**
 * The opened reasoning text. It sits directly in the step row's left-rule
 * panel (`ActivityReasoningBlock`); the row above already names it, so it adds
 * no card or heading of its own.
 */
export function AssistantReasoningPart() {
  const { text } = useMessagePartReasoning();
  // Reasoning renders as raw text, NOT through the markdown primitive, so it
  // does not inherit that component's `preprocess`. No leak has been observed
  // here (reasoning summaries carry no inline markers today), but this is
  // visible model-authored text and the strip is a pure function — leaving the
  // one uncovered surface open would make "markers never reach the rendered
  // message" untrue in the one place nobody would think to check.
  const visibleText = stripProviderCitationMarkers(text);

  return (
    <div
      className="text-muted-foreground text-sm leading-6 whitespace-pre-wrap"
      data-testid="local-reasoning-part"
    >
      {visibleText}
    </div>
  );
}
