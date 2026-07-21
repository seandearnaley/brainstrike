import { createScorer } from '@mastra/core/evals';

/**
 * Deterministic gate scorers for the agent-behavior eval suite (BST-589).
 *
 * Hand-rolled on core's stable `createScorer` instead of adding the separate
 * `@mastra/evals` package (its `checks.calledTool`/`noToolErrors` are the
 * upstream equivalents — keep these ids aligned for a later swap). A gate
 * must average 1.0 across the dataset or the runEvals verdict is 'failed'.
 *
 * The scorer run output for an agent target is the agent's output messages
 * (MastraDBMessage[]). Tool activity is discovered by a defensive deep walk
 * for tool-invocation-shaped objects: exact message-part dialects vary across
 * Mastra persistence versions, and a WRONG match here fails loudly in the
 * suite's control test (a gate that cannot fail is not evidence).
 */

interface ToolActivity {
  erroredToolNames: string[];
  toolNames: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissingToolResult(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.startsWith('Tool "') &&
    value.includes('" not found.. Call tools by their exact name only')
  );
}

function looksErrored(node: Record<string, unknown>): boolean {
  if (node['isError'] === true) {
    return true;
  }
  if (node['type'] === 'tool-error') {
    return true;
  }
  if (typeof node['errorText'] === 'string' || node['error'] !== undefined) {
    return true;
  }
  const state = node['state'];
  if (typeof state === 'string' && state.includes('error')) {
    return true;
  }
  const result = node['result'];
  if (isMissingToolResult(result)) {
    return true;
  }
  return (
    isRecord(result) &&
    (result['isError'] === true || result['ok'] === false || result['error'] !== undefined)
  );
}

function recordToolNode(node: Record<string, unknown>, activity: ToolActivity): void {
  const toolName = node['toolName'];
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return;
  }
  activity.toolNames.push(toolName);
  if (looksErrored(node)) {
    activity.erroredToolNames.push(toolName);
  }
}

function pushChildren(node: Record<string, unknown>, stack: unknown[]): void {
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      stack.push(...value);
    } else if (isRecord(value)) {
      stack.push(value);
    }
  }
}

/** Deep-walk arbitrary message JSON collecting tool names + errored calls. */
export function collectToolActivity(output: unknown): ToolActivity {
  const activity: ToolActivity = { erroredToolNames: [], toolNames: [] };
  const stack: unknown[] = [output];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || seen.has(node)) {
      continue;
    }
    seen.add(node);
    recordToolNode(node, activity);
    pushChildren(node, stack);
  }
  return activity;
}

/** Gate: the run called the named tool at least once. */
export function calledToolGate(toolName: string) {
  return createScorer({
    description: `Gate: the agent called the ${toolName} tool`,
    id: `called-tool-${toolName}`,
    type: 'agent',
  }).generateScore(({ run }) =>
    collectToolActivity(run.output).toolNames.includes(toolName) ? 1 : 0
  );
}

/** Gate: the run did not call the named tool. */
export function didNotCallToolGate(toolName: string) {
  return createScorer({
    description: `Gate: the agent did not call the ${toolName} tool`,
    id: `did-not-call-tool-${toolName}`,
    type: 'agent',
  }).generateScore(({ run }) =>
    collectToolActivity(run.output).toolNames.includes(toolName) ? 0 : 1
  );
}

/** Gate: no tool invocation in the run ended in an error. */
export function noToolErrorsGate() {
  return createScorer({
    description: 'Gate: no tool call errored during the run',
    id: 'no-tool-errors',
    type: 'agent',
  }).generateScore(({ run }) =>
    collectToolActivity(run.output).erroredToolNames.length === 0 ? 1 : 0
  );
}

function collectTextParts(output: unknown): string[] {
  if (!Array.isArray(output)) {
    return [];
  }
  const textParts: string[] = [];
  for (const message of output) {
    if (!(isRecord(message) && isRecord(message['content']))) {
      continue;
    }
    const parts = message['content']['parts'];
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      if (isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
        textParts.push(part['text']);
      }
    }
  }
  return textParts;
}

/** Advisory scorer: exact normalized response match against required ground truth. */
export function responseExactMatchScorer() {
  return createScorer({
    description: 'Advisory: the final response exactly matches the expected response',
    id: 'response-exact-match',
    type: 'agent',
  }).generateScore(({ run }) => {
    if (typeof run.groundTruth !== 'string') {
      throw new TypeError('response-exact-match requires a string groundTruth');
    }
    const response = collectTextParts(run.output).join('\n').trim();
    return response === run.groundTruth.trim() ? 1 : 0;
  });
}
