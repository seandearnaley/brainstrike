interface JsonStringState {
  escaped: boolean;
  inString: boolean;
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

export function balancedJsonCandidates(input: string): readonly string[] {
  const candidates: string[] = [];
  const direct = extractBalancedJsonContainer(input);
  if (direct) {
    candidates.push(direct);
  }
  const decodedInput = input.replaceAll('\\"', '"');
  if (decodedInput !== input) {
    const decoded = extractBalancedJsonContainer(decodedInput);
    if (decoded && !candidates.includes(decoded)) {
      candidates.push(decoded);
    }
  }
  return candidates;
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
