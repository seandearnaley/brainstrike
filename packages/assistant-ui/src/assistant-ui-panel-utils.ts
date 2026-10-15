export interface LocalModelLoadingStateForUtils {
  progress: number;
  stage: 'downloading' | 'generating' | 'loading' | 'ready' | 'error';
}

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
