#!/usr/bin/env node

// Guard: R6 in docs/agents/mastra-boundary.md makes Brainstrike's StreamChunk
// mapper the UI/persistence boundary. Mastra upgrades are allowed to add chunk
// types, but the new type must fail CI until it has a deliberate disposition;
// runtime-only parts must log a coded diagnostic instead of disappearing.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const AGENT_STREAMING_FILE = 'packages/agent/src/mastra/agent-streaming.ts';
const DATA_STREAM_MAPPER_FILE = 'packages/agent/src/stream/data-stream-mapper.ts';
const TOOL_EVENT_MAPPER_FILE = 'packages/agent/src/tool-projection/tool-event-mapper.ts';

const REQUIRED_SOURCE_PATTERNS = [
  {
    filePath: AGENT_STREAMING_FILE,
    patterns: [
      {
        label: "typed import { ChunkType } from '@mastra/core/stream'",
        pattern: /import\s+type\s*\{\s*ChunkType\s*\}\s*from\s*['"]@mastra\/core\/stream['"]/u,
      },
      {
        label: 'StaticMastraChunkType exclusion',
        pattern:
          /type\s+StaticMastraChunkType\s*=\s*Exclude<\s*ChunkType\[['"]type['"]\]\s*,\s*DynamicMastraChunkType\s*>/u,
      },
      {
        label: 'MastraChunkTypeMustStayLiteral widening assertion',
        pattern:
          /type\s+MastraChunkTypeMustStayLiteral\s*=\s*string\s+extends\s+ChunkType\[['"]type['"]\]\s*\?\s*never\s*:/u,
      },
      {
        label: 'MastraStaticChunkDisposition inventory',
        pattern: /Record<\s*StaticMastraChunkType\s*,\s*MastraStaticChunkDisposition\s*>/u,
      },
    ],
  },
];

const DISPATCH_DEFAULT_DIAGNOSTICS = [
  {
    code: 'mastra_agent_unrecognized_stream_chunk',
    filePath: AGENT_STREAMING_FILE,
    functionName: 'processMastraStreamPart',
    helperName: 'warnForUnrecognizedMastraStreamPart',
  },
  {
    code: 'data_stream_mapper_unrecognized_chunk',
    filePath: DATA_STREAM_MAPPER_FILE,
    functionName: 'handleChunk',
  },
  {
    code: 'mastra_tool_event_unrecognized_stream_chunk',
    filePath: TOOL_EVENT_MAPPER_FILE,
    functionName: 'mapMastraToolEvent',
  },
];

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
}

function isCodedLoggerWarn(node, code) {
  if (
    !(
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) ||
    node.expression.expression.text !== 'logger' ||
    node.expression.name.text !== 'warn'
  ) {
    return false;
  }
  return node.arguments.some(
    (argument) =>
      ts.isObjectLiteralExpression(argument) &&
      argument.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) &&
          propertyNameText(property.name) === 'code' &&
          ts.isStringLiteral(property.initializer) &&
          property.initializer.text === code
      )
  );
}

function namedFunctionHasCodedWarning(sourceFile, functionName, code) {
  let matched = false;

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === functionName &&
      node.body !== undefined
    ) {
      function visitBody(bodyNode) {
        if (isCodedLoggerWarn(bodyNode, code)) {
          matched = true;
          return;
        }
        ts.forEachChild(bodyNode, visitBody);
      }
      visitBody(node.body);
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return matched;
}

function namedDispatchHasCodedDefault(sourceFile, functionName, code, helperName) {
  let matched = false;

  function inspectDispatchBody(body) {
    function visitDispatch(node) {
      if (matched) {
        return;
      }
      if (ts.isDefaultClause(node)) {
        function visitDefault(defaultNode) {
          const callsHelper =
            helperName !== undefined &&
            ts.isCallExpression(defaultNode) &&
            ts.isIdentifier(defaultNode.expression) &&
            defaultNode.expression.text === helperName;
          if (callsHelper || (helperName === undefined && isCodedLoggerWarn(defaultNode, code))) {
            matched = true;
            return;
          }
          ts.forEachChild(defaultNode, visitDefault);
        }
        visitDefault(node);
        return;
      }
      ts.forEachChild(node, visitDispatch);
    }
    visitDispatch(body);
  }

  function visit(node) {
    const isTargetFunction =
      ts.isFunctionDeclaration(node) && node.name?.text === functionName && node.body;
    const isTargetMethod =
      ts.isMethodDeclaration(node) &&
      propertyNameText(node.name) === functionName &&
      node.body !== undefined;
    if (isTargetFunction || isTargetMethod) {
      inspectDispatchBody(node.body);
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return (
    matched &&
    (helperName === undefined || namedFunctionHasCodedWarning(sourceFile, helperName, code))
  );
}

/**
 * Returns violations for the R6 unknown-chunk contract. The guard intentionally
 * examines only the three load-bearing dispatch files; a broad search would
 * make adding an unrelated diagnostic appear to satisfy this boundary.
 */
export async function findMastraStreamChunkContractViolations({ root = REPO_ROOT } = {}) {
  const violations = [];
  const sources = new Map();

  for (const filePath of [AGENT_STREAMING_FILE, DATA_STREAM_MAPPER_FILE, TOOL_EVENT_MAPPER_FILE]) {
    let source;
    try {
      source = await readFile(path.join(root, filePath), 'utf8');
    } catch (error) {
      violations.push({
        filePath,
        reason: `could not read required R6 dispatch file: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    sources.set(filePath, source);
  }

  for (const { filePath, patterns } of REQUIRED_SOURCE_PATTERNS) {
    const source = sources.get(filePath);
    if (source === undefined) {
      continue;
    }
    for (const { label, pattern } of patterns) {
      if (!pattern.test(source)) {
        violations.push({
          filePath,
          reason: `missing R6 contract ${label}`,
        });
      }
    }
  }

  for (const { code, filePath, functionName, helperName } of DISPATCH_DEFAULT_DIAGNOSTICS) {
    const source = sources.get(filePath);
    if (source === undefined) {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    if (!namedDispatchHasCodedDefault(sourceFile, functionName, code, helperName)) {
      violations.push({
        filePath,
        reason: `dispatch ${functionName} default lacks coded logger.warn ${code}`,
      });
    }
  }

  return { violations };
}

async function main() {
  const { violations } = await findMastraStreamChunkContractViolations();
  if (violations.length === 0) {
    console.log(
      'Mastra stream chunk contract intact: typed coverage and coded diagnostics are present.'
    );
    return;
  }

  console.error(
    'Mastra stream chunk contract failed. See docs/agents/mastra-boundary.md R6. Violations:'
  );
  for (const violation of violations) {
    console.error(`- ${violation.filePath} — ${violation.reason}`);
  }
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}
