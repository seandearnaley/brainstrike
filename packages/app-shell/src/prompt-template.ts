export class PromptTemplateMissingVariablesError extends Error {
  readonly missingVariables: readonly string[];

  constructor(missingVariables: readonly string[]) {
    super(`Missing prompt template variables: ${missingVariables.join(', ')}`);
    this.name = 'PromptTemplateMissingVariablesError';
    this.missingVariables = Object.freeze([...missingVariables]);
  }
}

interface PromptTemplateVariableOccurrence {
  end: number;
  name: string;
  start: number;
}

const EXACT_PLACEHOLDER_PATTERN = /\{\{([^{}]+)\}\}/g;

function normalizeVariableName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function findVariableOccurrences(template: string): PromptTemplateVariableOccurrence[] {
  const occurrences: PromptTemplateVariableOccurrence[] = [];

  for (const match of template.matchAll(EXACT_PLACEHOLDER_PATTERN)) {
    const start = match.index;
    const rawName = match[1];
    if (start === undefined || rawName === undefined) {
      continue;
    }

    const end = start + match[0].length;
    const hasAdjacentBrace = template[start - 1] === '{' || template[end] === '}';
    const name = normalizeVariableName(rawName);
    if (hasAdjacentBrace || name.length === 0) {
      continue;
    }

    occurrences.push({ end, name, start });
  }

  return occurrences;
}

export function extractPromptTemplateVariables(template: string): string[] {
  const uniqueVariables = new Set<string>();

  for (const occurrence of findVariableOccurrences(template)) {
    uniqueVariables.add(occurrence.name);
  }

  return [...uniqueVariables];
}

export function renderPromptTemplate(
  template: string,
  values: Readonly<Record<string, string>>
): string {
  const occurrences = findVariableOccurrences(template);
  const variables = [...new Set(occurrences.map(({ name }) => name))];
  const missingVariables = variables.filter(
    (name) => !Object.hasOwn(values, name) || typeof values[name] !== 'string'
  );

  if (missingVariables.length > 0) {
    throw new PromptTemplateMissingVariablesError(missingVariables);
  }

  let cursor = 0;
  let rendered = '';

  for (const occurrence of occurrences) {
    rendered += template.slice(cursor, occurrence.start);
    rendered += values[occurrence.name];
    cursor = occurrence.end;
  }

  return rendered + template.slice(cursor);
}
