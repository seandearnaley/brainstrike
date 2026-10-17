import type { HostToolDefinitions as ToolsInput } from '../host-tool-definition';

export function sanitizeToolName(name: string): string {
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

function createSanitizedToolName(
  originalName: string,
  usedNames: Set<string>
): { originalName: string; sanitizedName: string } {
  const baseName = sanitizeToolName(originalName);
  const sanitizedName = ensureUniqueSanitizedName(baseName, originalName, usedNames);
  return { originalName, sanitizedName };
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

export function createSanitizedToolNameMap(toolNames: Iterable<string>): Map<string, string> {
  const sanitizedToOriginal = new Map<string, string>();
  const usedNames = new Set<string>();

  for (const toolName of toolNames) {
    const { originalName, sanitizedName } = createSanitizedToolName(toolName, usedNames);
    sanitizedToOriginal.set(sanitizedName, originalName);
  }

  return sanitizedToOriginal;
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
    const { sanitizedName: uniqueName } = createSanitizedToolName(name, usedNames);

    map.set(uniqueName, name);

    if (uniqueName === name) {
      sanitized[uniqueName] = tool;
    } else {
      const cloned = Object.create(Object.getPrototypeOf(tool));
      Object.defineProperties(cloned, Object.getOwnPropertyDescriptors(tool));
      cloned.id = uniqueName;
      sanitized[uniqueName] = cloned;
    }
  }

  return sanitized;
}

export type { HostToolDefinitions as ToolsInput } from '../host-tool-definition';
