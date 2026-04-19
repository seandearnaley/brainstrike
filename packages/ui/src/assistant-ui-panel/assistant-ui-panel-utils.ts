export interface LocalModelLoadingStateForUtils {
  progress: number;
  stage: 'downloading' | 'generating' | 'loading' | 'ready' | 'error';
}

export interface AssistantContextMenuConfigForUtils {
  contextTokenCount?: number;
  tokenBudget?: number;
}

export type BudgetStatus = 'near' | 'over' | 'within';

export function getLocalModelStatusLabel(stage: LocalModelLoadingStateForUtils['stage']): string {
  switch (stage) {
    case 'downloading':
      return 'Downloading';
    case 'loading':
      return 'Starting';
    case 'generating':
      return 'Working';
    case 'ready':
      return 'Ready';
    case 'error':
      return 'Unavailable';
  }
}

export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

export function truncateMiddle(value: string, head = 12, tail = 6): string {
  if (value.length <= head + tail + 3) {
    return value;
  }
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function resolveBudgetStatus(
  contextMenu?: AssistantContextMenuConfigForUtils | undefined
): BudgetStatus | undefined {
  if (
    typeof contextMenu?.contextTokenCount !== 'number' ||
    typeof contextMenu.tokenBudget !== 'number' ||
    contextMenu.tokenBudget <= 0
  ) {
    return;
  }

  if (contextMenu.contextTokenCount > contextMenu.tokenBudget) {
    return 'over';
  }

  if (contextMenu.contextTokenCount >= contextMenu.tokenBudget * 0.85) {
    return 'near';
  }

  return 'within';
}

export function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

export function parseNumber(value: string): number | undefined {
  if (!value.trim()) {
    return;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
