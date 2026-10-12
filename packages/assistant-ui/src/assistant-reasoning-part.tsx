import { useMessagePartReasoning } from '@assistant-ui/react';
import { stripProviderCitationMarkers } from '@brainstrike/assistant-contract/citation-markers';

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
    <div className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-3">
      <p className="mb-2 font-medium text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
        Thinking
      </p>
      <div
        className="whitespace-pre-wrap text-muted-foreground text-sm leading-6"
        data-testid="local-reasoning-part"
      >
        {visibleText}
      </div>
    </div>
  );
}
