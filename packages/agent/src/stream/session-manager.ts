export function parseEventId(
  value: string | null | undefined
): { sessionId: string; sequence: number } | undefined {
  if (!value) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  const [sessionId, sequenceRaw] = trimmed.split(':');
  if (!(sessionId && sequenceRaw)) {
    return;
  }
  const sequence = Number.parseInt(sequenceRaw, 10);
  if (!Number.isFinite(sequence) || sequence < -1) {
    return;
  }
  return { sequence, sessionId };
}
