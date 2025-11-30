import type { ToolsInput } from '@mastra/core/agent';

function sanitizeToolNameBase(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (sanitized.trim().length > 0) {
    return sanitized;
  }
  return 'tool';
}

function createStableHashSuffix(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function ensureUniqueSanitizedName(
  baseName: string,
  originalName: string,
  usedNames: Set<string>
): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  const hash = createStableHashSuffix(originalName);
  let candidate = `${baseName}_${hash}`;
  if (!usedNames.has(candidate)) {
    usedNames.add(candidate);
    return candidate;
  }

  let counter = 1;
  while (true) {
    candidate = `${baseName}_${hash}_${counter}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    counter += 1;
  }
}

export function sanitizeTools(
  tools: ToolsInput | undefined,
  map: Map<string, string>
): ToolsInput | undefined {
  if (!tools) {
    return;
  }

  const sanitized: ToolsInput = {};
  const usedNames = new Set<string>(map.keys());

  for (const [name, tool] of Object.entries(tools)) {
    const baseName = sanitizeToolNameBase(name);
    const uniqueName = ensureUniqueSanitizedName(baseName, name, usedNames);

    map.set(uniqueName, name);

    if (uniqueName !== name) {
      const cloned = Object.assign(Object.create(Object.getPrototypeOf(tool)), tool);
      cloned.id = uniqueName;
      sanitized[uniqueName] = cloned;
    } else {
      sanitized[uniqueName] = tool;
    }
  }

  return sanitized;
}

export type { ToolsInput } from '@mastra/core/agent';
