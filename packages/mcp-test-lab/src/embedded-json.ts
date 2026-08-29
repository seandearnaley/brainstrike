interface JsonStringState {
  escaped: boolean;
  inString: boolean;
}

const JSON_UNICODE_ESCAPE_PATTERN = /\\u([0-9a-f]{4})/giu;

export function decodeJsonUnicodeEscapes(value: string): string {
  return value.replace(JSON_UNICODE_ESCAPE_PATTERN, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

function consumeStringCharacter(character: string | undefined, state: JsonStringState): boolean {
  if (!state.inString) {
    return false;
  }
  if (state.escaped) {
    state.escaped = false;
  } else if (character === '\\') {
    state.escaped = true;
  } else if (character === '"') {
    state.inString = false;
  }
  return true;
}

function consumeContainerCharacter(
  character: string | undefined,
  stack: string[]
): 'complete' | 'continue' | 'invalid' {
  if (character === '{' || character === '[') {
    stack.push(character === '{' ? '}' : ']');
    return 'continue';
  }
  if (character !== '}' && character !== ']') {
    return 'continue';
  }
  if (stack.at(-1) !== character) {
    return 'invalid';
  }
  stack.pop();
  return stack.length === 0 ? 'complete' : 'continue';
}

function extractBalancedJsonContainer(input: string): string | undefined {
  const opening = input[0];
  if (opening !== '{' && opening !== '[') {
    return;
  }
  const stack: string[] = [opening === '{' ? '}' : ']'];
  const stringState: JsonStringState = { escaped: false, inString: false };
  for (let index = 1; index < input.length; index += 1) {
    const character = input[index];
    if (consumeStringCharacter(character, stringState)) {
      continue;
    }
    if (character === '"') {
      stringState.inString = true;
      continue;
    }
    const result = consumeContainerCharacter(character, stack);
    if (result === 'invalid') {
      return;
    }
    if (result === 'complete') {
      return input.slice(0, index + 1);
    }
  }
  return;
}

export function embeddedJsonStarts(line: string, limit: number): readonly number[] | undefined {
  const starts: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character !== '{' && character !== '[') {
      continue;
    }
    if (starts.length >= limit) {
      return;
    }
    starts.push(index);
  }
  return starts;
}

export function advanceLineOffset(text: string, lineOffset: number, lineLength: number): number {
  const separatorOffset = lineOffset + lineLength;
  if (text.startsWith('\r\n', separatorOffset)) {
    return separatorOffset + 2;
  }
  return text[separatorOffset] === '\n' ? separatorOffset + 1 : separatorOffset;
}

export interface BalancedJsonCandidateResult {
  readonly candidates: readonly string[];
  readonly decodingLimitExceeded: boolean;
}

export function balancedJsonCandidates(
  input: string,
  maxDecodingDepth: number
): BalancedJsonCandidateResult {
  const candidates: string[] = [];
  let decodedInput = input;
  for (let depth = 0; depth <= maxDecodingDepth; depth += 1) {
    const candidate = extractBalancedJsonContainer(decodedInput);
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
    const next = decodedInput.replaceAll('\\"', '"');
    if (next === decodedInput) {
      return { candidates, decodingLimitExceeded: false };
    }
    if (depth === maxDecodingDepth) {
      return { candidates, decodingLimitExceeded: true };
    }
    decodedInput = next;
  }
  return { candidates, decodingLimitExceeded: false };
}

export function parseJsonCandidate(candidate: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(candidate) as unknown };
  } catch {
    // A prefixed log may carry a JSON value whose quotes remain escaped.
  }
  try {
    const decoded: unknown = JSON.parse(`"${candidate}"`);
    if (typeof decoded === 'string') {
      return { value: JSON.parse(decoded) as unknown };
    }
  } catch {
    return;
  }
  return;
}
