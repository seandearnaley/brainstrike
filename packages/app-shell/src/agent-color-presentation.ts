import type { AssistantThreadColorId } from '@brainstrike/assistant-data';
import { type AgentColor, getAgentColorStyles } from '@brainstrike/types/agent-color';
import type { CSSProperties } from 'react';
import { ASSISTANT_THREAD_COLOR_PRESENTATION } from './assistant-thread-presentation';

/** One durable identity has the same appearance on every navigation surface. */
export function getDelegatedColorPresentation(color: AgentColor): {
  readonly accentClassName: string;
  readonly idleClassName: string;
  readonly markClassName: string;
  readonly selectedClassName: string;
  readonly style: CSSProperties;
} {
  if (color.startsWith('family:')) {
    return {
      accentClassName: 'bs-agent-family-accent',
      idleClassName: 'bs-agent-family bs-agent-family-idle',
      markClassName: 'bs-agent-solid-mark bs-agent-family-mark',
      selectedClassName: 'bs-agent-family bs-agent-family-selected',
      style: getAgentColorStyles(color) as CSSProperties,
    };
  }
  return { ...ASSISTANT_THREAD_COLOR_PRESENTATION[color as AssistantThreadColorId], style: {} };
}
