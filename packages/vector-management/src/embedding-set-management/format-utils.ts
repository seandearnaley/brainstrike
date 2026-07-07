export function formatRelativeTimeFromNow(input: string | null): string {
  if (!input) {
    return 'never';
  }
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) {
    return 'unknown';
  }

  const diffMs = Date.now() - parsed;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diffMs < 0) {
    return 'just now';
  }
  if (diffMs < minute) {
    return 'just now';
  }
  if (diffMs < hour) {
    const minutes = Math.floor(diffMs / minute);
    return `${minutes}m ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return `${hours}h ago`;
  }
  if (diffMs < week) {
    const days = Math.floor(diffMs / day);
    return `${days}d ago`;
  }

  try {
    return new Date(parsed).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return new Date(parsed).toISOString().split('T')[0] ?? 'unknown';
  }
}
