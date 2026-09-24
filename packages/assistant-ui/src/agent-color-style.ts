import { getAgentColorStyles, isAgentColor } from '@brainstrike/types/agent-color';
import type { CSSProperties } from 'react';

/** Only validated durable colors may become CSS values. */
export function agentColorStyle(colorId: string | undefined): CSSProperties | undefined {
  if (colorId === undefined || colorId === 'unresolved') {
    return undefined;
  }
  if (!isAgentColor(colorId)) {
    throw new Error('Invalid agent color token.');
  }
  return getAgentColorStyles(colorId) as CSSProperties;
}
