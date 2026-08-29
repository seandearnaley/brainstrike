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

interface ExtractedJsonContainer {
  readonly candidate: string;
  readonly end: number;
}

function extractBalancedJsonContainer(
  input: string,
  start = 0
): ExtractedJsonContainer | undefined {
  const opening = input[start];
  if (opening !== '{' && opening !== '[') {
    return;
  }
  const stack: string[] = [opening === '{' ? '}' : ']'];
  const stringState: JsonStringState = { escaped: false, inString: false };
  for (let index = start + 1; index < input.length; index += 1) {
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
      return { candidate: input.slice(start, index + 1), end: index + 1 };
    }
  }
  return;
}

export function embeddedJsonStarts(input: string, limit: number): readonly number[] | undefined {
  const starts: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== '{' && character !== '[') {
      continue;
    }
    if (starts.length >= limit) {
      return;
    }
    starts.push(index);
    const extracted = extractBalancedJsonContainer(input, index);
    if (extracted !== undefined) {
      index = extracted.end - 1;
    }
  }
  return starts;
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
    const extracted = extractBalancedJsonContainer(decodedInput);
    if (extracted !== undefined && !candidates.includes(extracted.candidate)) {
      candidates.push(extracted.candidate);
    }
    const next = decodeEscapedJsonQuotes(decodedInput);
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

function decodeEscapedJsonQuotes(input: string): string {
  return input.replace(/\\+(?=")/gu, (slashes) =>
    slashes.length % 2 === 0 ? slashes : '\\'.repeat((slashes.length - 1) / 2)
  );
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
