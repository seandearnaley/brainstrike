/**
 * Tool call parsing for local LLM output.
 * Supports multiple formats: FunctionGemma, Qwen, LFM2.5, and generic JSON.
 * All parsers use iterative string parsing to prevent ReDoS attacks.
 */
import { createLogger } from '@brainstrike/utils';
import type { LocalLlmToolCall } from './types';

const logger = createLogger('LocalLlmToolParser');

/**
 * Maximum output length for tool call parsing (100KB).
 * Prevents ReDoS attacks from unbounded regex matching on large inputs.
 * Set to 100KB to support legitimate use cases like code generation.
 */
const MAX_OUTPUT_LENGTH = 100_000;

/**
 * Check output length for ReDoS protection.
 * Throws descriptive error if output exceeds maximum length.
 */
function validateOutputLength(output: string, parser: string): void {
  if (output.length > MAX_OUTPUT_LENGTH) {
    throw new Error(
      `Tool call output exceeds maximum length (${output.length} > ${MAX_OUTPUT_LENGTH} bytes). ` +
        `Parser: ${parser}. This limit prevents ReDoS attacks. ` +
        'If this is a legitimate use case, consider chunking the output.'
    );
  }
}

/**
 * Parse FunctionGemma format: <start_function_call>call:name{args}<end_function_call>
 * Uses iterative string parsing instead of regex to prevent ReDoS attacks.
 */
function parseGemmaFormat(output: string): LocalLlmToolCall | null {
  validateOutputLength(output, 'gemma');

  const startTag = '<start_function_call>call:';
  const endTag = '<end_function_call>';

  const startIdx = output.indexOf(startTag);
  if (startIdx === -1) {
    return null;
  }

  const endIdx = output.indexOf(endTag, startIdx);
  if (endIdx === -1) {
    return null;
  }

  const content = output.substring(startIdx + startTag.length, endIdx);

  const braceIdx = content.indexOf('{');
  if (braceIdx === -1) {
    return null;
  }

  const closeBraceIdx = content.lastIndexOf('}');
  if (closeBraceIdx === -1 || closeBraceIdx < braceIdx) {
    return null;
  }

  const name = content.substring(0, braceIdx).trim();
  const argsStr = content.substring(braceIdx + 1, closeBraceIdx);

  if (!/^\w+$/.test(name)) {
    return null;
  }

  const args: Record<string, string> = {};
  if (argsStr) {
    for (const pair of argsStr.split(',')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) {
        continue;
      }

      const key = pair.substring(0, colonIdx).trim();
      const value = pair
        .substring(colonIdx + 1)
        .replace(/<escape>/g, '')
        .trim();

      if (key && value) {
        args[key] = value;
      }
    }
  }

  return {
    id: `call_${crypto.randomUUID()}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/**
 * Parse Qwen format: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 * Uses iterative string parsing instead of regex to prevent ReDoS attacks.
 */
function parseQwenFormat(output: string): LocalLlmToolCall | null {
  validateOutputLength(output, 'qwen');

  const startTag = '<tool_call>';
  const endTag = '</tool_call>';

  const startIdx = output.indexOf(startTag);
  if (startIdx === -1) {
    return null;
  }

  const endIdx = output.indexOf(endTag, startIdx);
  if (endIdx === -1) {
    return null;
  }

  const jsonContent = output.substring(startIdx + startTag.length, endIdx).trim();
  if (!jsonContent) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonContent) as {
      name: string;
      arguments: Record<string, unknown>;
    };

    if (typeof parsed.name !== 'string') {
      logger.debug('Qwen tool call missing name field');
      return null;
    }

    return {
      id: `call_${crypto.randomUUID()}`,
      type: 'function',
      function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments ?? {}) },
    };
  } catch {
    logger.debug('Failed to parse Qwen tool call JSON', { raw: jsonContent });
    return null;
  }
}

/**
 * Parse generic JSON format: {"name": "...", "arguments": {...}}
 * Uses iterative string parsing with JSON.parse instead of regex to prevent ReDoS attacks.
 */
function parseGenericJsonFormat(output: string): LocalLlmToolCall | null {
  validateOutputLength(output, 'genericJson');

  const namePattern = '"name"';
  const nameIdx = output.indexOf(namePattern);
  if (nameIdx === -1) {
    return null;
  }

  let startIdx = nameIdx;
  while (startIdx > 0 && output[startIdx] !== '{') {
    startIdx--;
  }
  if (output[startIdx] !== '{') {
    return null;
  }

  let depth = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < output.length; i++) {
    if (output[i] === '{') {
      depth++;
    }
    if (output[i] === '}') {
      depth--;
    }
    if (depth === 0) {
      endIdx = i + 1;
      break;
    }
  }
  if (depth !== 0) {
    return null;
  }

  const jsonStr = output.substring(startIdx, endIdx);

  try {
    const parsed = JSON.parse(jsonStr) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };

    if (typeof parsed.name !== 'string' || !/^\w+$/.test(parsed.name)) {
      return null;
    }

    return {
      id: `call_${crypto.randomUUID()}`,
      type: 'function',
      function: {
        name: parsed.name,
        arguments: parsed.arguments ? JSON.stringify(parsed.arguments) : '{}',
      },
    };
  } catch {
    logger.debug('Failed to parse generic JSON tool call', { raw: jsonStr });
    return null;
  }
}

/**
 * Parse LFM2.5 Pythonic format: <|tool_call_start|>[func_name(arg="value")]<|tool_call_end|>
 * Uses iterative string parsing for tag boundaries to prevent ReDoS attacks.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Parses multiple argument formats (strings, numbers, booleans)
function parseLfmFormat(output: string): LocalLlmToolCall | null {
  validateOutputLength(output, 'lfm');

  const startTag = '<|tool_call_start|>';
  const endTag = '<|tool_call_end|>';

  const startIdx = output.indexOf(startTag);
  if (startIdx === -1) {
    return null;
  }

  const endIdx = output.indexOf(endTag, startIdx);
  if (endIdx === -1) {
    return null;
  }

  const content = output.substring(startIdx + startTag.length, endIdx).trim();

  if (!(content.startsWith('[') && content.endsWith(']'))) {
    return null;
  }

  const innerContent = content.substring(1, content.length - 1);
  const parenIdx = innerContent.indexOf('(');
  const closeParenIdx = innerContent.lastIndexOf(')');

  if (parenIdx === -1 || closeParenIdx === -1 || closeParenIdx < parenIdx) {
    return null;
  }

  const funcName = innerContent.substring(0, parenIdx).trim();
  const argsStr = innerContent.substring(parenIdx + 1, closeParenIdx);

  if (!/^\w+$/.test(funcName)) {
    return null;
  }

  const args: Record<string, string | number | boolean> = {};

  if (argsStr) {
    let currentArg = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i <= argsStr.length; i++) {
      const char = argsStr[i];

      if (i === argsStr.length || (char === ',' && !inQuote)) {
        const arg = currentArg.trim();
        if (arg) {
          const eqIdx = arg.indexOf('=');
          if (eqIdx > 0) {
            const key = arg.substring(0, eqIdx).trim();
            const value = arg.substring(eqIdx + 1).trim();

            if (/^\w+$/.test(key)) {
              if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
              ) {
                args[key] = value.substring(1, value.length - 1);
              } else if (/^\d+(\.\d+)?$/.test(value)) {
                args[key] = Number.parseFloat(value);
              } else if (value.toLowerCase() === 'true') {
                args[key] = true;
              } else if (value.toLowerCase() === 'false') {
                args[key] = false;
              } else {
                args[key] = value;
              }
            }
          }
        }
        currentArg = '';
      } else {
        if ((char === '"' || char === "'") && (i === 0 || argsStr[i - 1] !== '\\')) {
          if (!inQuote) {
            inQuote = true;
            quoteChar = char;
          } else if (char === quoteChar) {
            inQuote = false;
            quoteChar = '';
          }
        }
        currentArg += char;
      }
    }
  }

  return {
    id: `call_${crypto.randomUUID()}`,
    type: 'function',
    function: { name: funcName, arguments: JSON.stringify(args) },
  };
}

/**
 * Parse function call from model output.
 * Supports multiple formats used by different models.
 */
export function parseFunctionCall(output: string): LocalLlmToolCall | null {
  return (
    parseLfmFormat(output) ??
    parseGemmaFormat(output) ??
    parseQwenFormat(output) ??
    parseGenericJsonFormat(output)
  );
}

export { MAX_OUTPUT_LENGTH, validateOutputLength };
