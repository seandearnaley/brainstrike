import type { AssistantThreadColorId } from '@brainstrike/assistant-data';
import {
  type AgentColor,
  createAgentFamilyColor,
  getAgentColorStyles,
} from '@brainstrike/types/agent-color';
import { type CSSProperties, type ReactElement, useMemo } from 'react';

function previewColors(root: AssistantThreadColorId): readonly AgentColor[] {
  const siblings: AgentColor[] = [];
  for (const id of ['preview-first', 'preview-second', 'preview-third']) {
    siblings.push(createAgentFamilyColor(root, id, siblings, [root, ...siblings]));
  }
  const descendants: AgentColor[] = [];
  for (const id of ['preview-grandchild-first', 'preview-grandchild-second']) {
    descendants.push(
      createAgentFamilyColor(siblings[1] ?? root, id, descendants, [
        root,
        ...siblings,
        ...descendants,
      ])
    );
  }
  return [root, ...siblings, ...descendants];
}

const NODE_POSITIONS = [
  { id: 'root', x: 14, y: 24 },
  { id: 'first', x: 100, y: 8 },
  { id: 'second', x: 100, y: 24 },
  { id: 'third', x: 100, y: 40 },
  { id: 'grandchild-first', x: 198, y: 16 },
  { id: 'grandchild-second', x: 198, y: 32 },
] as const;

export function ThreadColorFamilyPreview({
  rootColor,
}: {
  readonly rootColor: AssistantThreadColorId | null;
}): ReactElement {
  const colors = useMemo(() => previewColors(rootColor ?? 'blue'), [rootColor]);
  return (
    <div className="mt-2 border-t pt-2" data-testid="thread-color-family-preview">
      <p className="text-[11px] text-muted-foreground">New agents get distinct, related colors.</p>
      <p className="sr-only">
        Preview: one root agent branches to three child agents; one child branches to two more.
      </p>
      <svg
        aria-hidden="true"
        className="mt-1 h-10 w-full"
        preserveAspectRatio="xMidYMid meet"
        viewBox="0 0 216 48"
      >
        <g className="stroke-border" fill="none" strokeWidth="1.5">
          <path d="M20 24 H57 V8 H94 M57 24 H94 M57 24 V40 H94" />
          <path d="M106 24 H150 V16 H192 M150 24 V32 H192" />
        </g>
        {NODE_POSITIONS.map((position, index) => {
          const color = colors[index];
          if (!color) {
            return null;
          }
          return (
            <circle
              className="fill-[var(--agent-accent-light)] dark:fill-[var(--agent-accent-dark)]"
              cx={position.x}
              cy={position.y}
              key={position.id}
              r={position.id === 'root' ? 6 : 5}
              style={getAgentColorStyles(color) as CSSProperties}
            />
          );
        })}
      </svg>
      <p className="text-[10px] text-muted-foreground leading-3">
        Changing this color sets the starting point for new agents.
      </p>
    </div>
  );
}
