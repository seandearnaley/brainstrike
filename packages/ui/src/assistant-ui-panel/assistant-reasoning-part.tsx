import { useMessagePartReasoning } from '@assistant-ui/react';

export function AssistantReasoningPart() {
  const { text } = useMessagePartReasoning();

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-3">
      <p className="mb-2 font-medium text-[10px] text-muted-foreground uppercase tracking-[0.14em]">
        Thinking
      </p>
      <div
        className="whitespace-pre-wrap text-muted-foreground text-sm leading-6"
        data-testid="local-reasoning-part"
      >
        {text}
      </div>
    </div>
  );
}
