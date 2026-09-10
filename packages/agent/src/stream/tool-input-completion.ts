/** Ignore only JSON whitespace outside strings; never alter a partial string value. */
function compactJsonPrefix(text: string): string {
  let quoted = false;
  let escaped = false;
  let compact = '';
  for (const character of text) {
    if (quoted) {
      compact += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    }
    if (!' \t\r\n'.includes(character)) {
      compact += character;
    }
  }
  return compact;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key: string, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))
        )
      : entry
  );
}

/** Argument streams are append-only. Complete a compatible prefix or report a mismatch. */
export function completeToolInputText(pending: string, args: unknown): string {
  const complete = JSON.stringify(args);
  const prefix = compactJsonPrefix(pending);
  if (complete.startsWith(prefix)) {
    return complete.slice(prefix.length);
  }
  // Already complete JSON may use different whitespace, key order or escape spelling.
  let parsed: unknown;
  try {
    parsed = JSON.parse(pending);
  } catch {
    throw new Error('Complete tool input cannot extend the streamed JSON arguments.');
  }
  if (canonicalJson(parsed) !== canonicalJson(args)) {
    throw new Error('Complete tool input disagrees with the streamed JSON arguments.');
  }
  return '';
}
