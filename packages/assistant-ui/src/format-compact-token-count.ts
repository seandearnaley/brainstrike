import { formatTokenCount } from '@brainstrike/tokenization';

/** Strip the trailing " tokens" suffix from formatTokenCount output for compact display. */
export function formatCompact(count: number): string {
  return formatTokenCount(count).replace(' tokens', '');
}
