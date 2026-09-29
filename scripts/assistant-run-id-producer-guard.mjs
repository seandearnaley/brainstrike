#!/usr/bin/env node

// Guard: the desktop MAIN process writes run events and run outcomes keyed by
// `memory.runId`, and those writes assume the parent
// `brainstrike_assistant_thread_runs` row exists (migration 118 creates both
// tables; the event writer silently no-ops on a missing parent and the hook
// outcome writer throws). What keeps that assumption true is runId PROVENANCE:
// the single producer of a `memory.runId` is `createThreadRunId`, whose only
// caller awaits `repository.createThreadRun` with it. A SECOND producer that
// mints an id without creating the row makes those writes fail, and only
// partly loudly.
//
// See docs/agents/assistant-persistence.md
// § RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP.
//
// SCOPE — read before trusting a green run. This guard pins the identity and
// reach of the EXISTING producer:
//   - `createThreadRunId` is declared exactly once, in the owning module;
//   - it has exactly one call site, in that same module;
//   - it is NOT exported, so no other module can reuse it;
//   - `createThreadRun` takes a branded `HostRunId`
//     (`@brainstrike/assistant-contract/host-run-id`), and the brand is
//     constructed exactly once: the `as HostRunId` assertion inside
//     `createThreadRunId`. Any other production assertion or type argument
//     naming `HostRunId`, and any renaming import or export of it, is flagged.
// The brand closes the gap for minters that call `createThreadRun`. A minter
// that skips `createThreadRun` entirely (`crypto.randomUUID()` in a
// background/cron run) is still invisible here, as are assertions that never
// name the brand: a type alias hiding it, `as never`, or an indexed access
// such as `CreateAssistantThreadRunInput['id']`. That residual gap is why the doc section, not this script,
// is the authority. Widening the guard to "any id-shaped expression reaching a
// memory payload" was considered and rejected as unmaintainably fuzzy.

import { glob, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PRODUCER_NAME = 'createThreadRunId';
const BRAND_NAME = 'HostRunId';
const OWNING_FILE = 'packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts';

const SOURCE_PATTERNS = [
  'apps/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
  'packages/**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}',
];

const IGNORE_PATTERNS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/.git',
  '**/.git/**',
  '**/dist',
  '**/dist/**',
  '**/.turbo',
  '**/.turbo/**',
  '**/build',
  '**/build/**',
  '**/coverage',
  '**/coverage/**',
  '**/playwright-report',
  '**/playwright-report/**',
  '**/test-results',
  '**/test-results/**',
  '**/.vite',
  '**/.vite/**',
  '**/blob-report',
  '**/blob-report/**',
  '**/reports',
  '**/reports/**',
  // Tests may reference the producer freely; they cannot introduce a
  // production request path.
  '**/__tests__',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/e2e',
  '**/e2e/**',
];

function getLineNumber(sourceText, matchIndex) {
  return sourceText.slice(0, matchIndex).split('\n').length;
}

function findProducerSyntax(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0];
    const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new Error(
      `${filePath}:${position.line + 1}:${position.character + 1}: could not be parsed, ` +
        `so runId provenance cannot be verified — ${ts.flattenDiagnosticMessageText(
          diagnostic.messageText,
          ' '
        )}`
    );
  }
  const brandConstructions = [];
  const brandRenames = [];
  const calls = [];
  const declarations = [];
  const exports = [];

  function visit(node, insideProducer) {
    const isProducerFunction =
      (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
      node.name?.text === PRODUCER_NAME;
    if (isProducerFunction) {
      declarations.push(node.name.getStart(sourceFile));
      if (
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        exports.push(node.name.getStart(sourceFile));
      }
    }

    if (ts.isIdentifier(node) && node.text === PRODUCER_NAME) {
      const isDeclarationName =
        (ts.isFunctionDeclaration(node.parent) || ts.isFunctionExpression(node.parent)) &&
        node.parent.name === node;
      if (isDeclarationName) {
        return;
      }

      if (ts.isExportSpecifier(node.parent) || ts.isExportAssignment(node.parent)) {
        exports.push(node.getStart(sourceFile));
      } else {
        // Any executable reference can leak or invoke the supposedly private
        // producer: direct calls, property access, constructors, aliases, and
        // imports all count. Comments and literals have no Identifier node.
        calls.push(node.getStart(sourceFile));
      }
    }

    const constructedType = brandConstructingType(node);
    if (constructedType && mentionsBrand(constructedType)) {
      brandConstructions.push({ insideProducer, position: node.getStart(sourceFile) });
    }
    if (
      (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) &&
      node.propertyName?.text === BRAND_NAME &&
      node.name.text !== BRAND_NAME
    ) {
      brandRenames.push(node.getStart(sourceFile));
    }

    ts.forEachChild(node, (child) => visit(child, insideProducer || isProducerFunction));
  }

  visit(sourceFile, false);
  return { brandConstructions, brandRenames, calls, declarations, exports };
}

// Generic containers and hooks whose type argument only describes what they
// hold; `new Map<string, HostRunId>()` or `useState<HostRunId | null>()` can
// store a brand but never mint one.
const NON_MINTING_GENERICS = new Set([
  'Array',
  'Map',
  'Promise',
  'Set',
  'WeakMap',
  'WeakSet',
  'useCallback',
  'useMemo',
  'useRef',
  'useState',
]);

function calleeName(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
}

/**
 * The type a node can mint a brand with: the target of an `as` or `<T>`
 * assertion, a type predicate (`value is HostRunId`), or the type arguments of
 * a call (`Brand.nominal<HostRunId>()`) other than a non-minting container.
 */
function brandConstructingType(node) {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return node.type;
  }
  if (ts.isTypePredicateNode(node)) {
    return node.type ?? null;
  }
  if (
    (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
    node.typeArguments &&
    !NON_MINTING_GENERICS.has(calleeName(node.expression))
  ) {
    return node.typeArguments;
  }
  return null;
}

function mentionsBrand(typeNodeOrNodes) {
  const pending = Array.isArray(typeNodeOrNodes) ? [...typeNodeOrNodes] : [typeNodeOrNodes];
  while (pending.length > 0) {
    const node = pending.pop();
    const referenced = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isImportTypeNode(node)
        ? node.qualifier
        : undefined;
    const name = referenced && (ts.isIdentifier(referenced) ? referenced : referenced.right);
    if (name?.text === BRAND_NAME) {
      return true;
    }
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * Scan non-test source for references to the run-id producer and its brand.
 * Returns `{ violations, brandConstructionCount, declarationCount, callCount }`;
 * violations carry `{ filePath, lineNumber, reason }`.
 */
export async function findAssistantRunIdProducerViolations({ root = REPO_ROOT } = {}) {
  const sourceFiles = (
    await Array.fromAsync(
      glob(SOURCE_PATTERNS, {
        cwd: root,
        exclude: IGNORE_PATTERNS,
        withFileTypes: true,
      })
    )
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
    );

  const violations = [];
  let brandConstructionCount = 0;
  let declarationCount = 0;
  let callCount = 0;

  for (const filePath of sourceFiles.sort()) {
    const sourceText = await readFile(path.join(root, filePath), 'utf8');
    if (!(sourceText.includes(PRODUCER_NAME) || sourceText.includes(BRAND_NAME))) {
      continue;
    }
    const producerSyntax = findProducerSyntax(filePath, sourceText);

    for (const matchIndex of producerSyntax.declarations) {
      declarationCount += 1;
      if (filePath !== OWNING_FILE) {
        violations.push({
          filePath,
          lineNumber: getLineNumber(sourceText, matchIndex),
          reason: `${PRODUCER_NAME} must be declared only in ${OWNING_FILE}`,
        });
      }
    }

    for (const matchIndex of producerSyntax.exports) {
      violations.push({
        filePath,
        lineNumber: getLineNumber(sourceText, matchIndex),
        reason: `${PRODUCER_NAME} must stay module-private (exporting it lets another module mint a runId)`,
      });
    }

    for (const { insideProducer, position } of producerSyntax.brandConstructions) {
      if (filePath === OWNING_FILE && insideProducer) {
        brandConstructionCount += 1;
      } else {
        violations.push({
          filePath,
          lineNumber: getLineNumber(sourceText, position),
          reason: `${BRAND_NAME} may be asserted only inside ${PRODUCER_NAME} in ${OWNING_FILE}`,
        });
      }
    }

    for (const matchIndex of producerSyntax.brandRenames) {
      violations.push({
        filePath,
        lineNumber: getLineNumber(sourceText, matchIndex),
        reason: `${BRAND_NAME} must not be renamed on import or export (this guard matches it by name)`,
      });
    }

    for (const matchIndex of producerSyntax.calls) {
      callCount += 1;
      if (filePath !== OWNING_FILE) {
        violations.push({
          filePath,
          lineNumber: getLineNumber(sourceText, matchIndex),
          reason: `${PRODUCER_NAME} must be called only in ${OWNING_FILE}`,
        });
      }
    }
  }

  if (declarationCount !== 1) {
    violations.push({
      filePath: OWNING_FILE,
      lineNumber: 0,
      reason: `expected exactly 1 declaration of ${PRODUCER_NAME}, found ${declarationCount}`,
    });
  }
  if (callCount !== 1) {
    violations.push({
      filePath: OWNING_FILE,
      lineNumber: 0,
      reason: `expected exactly 1 call site of ${PRODUCER_NAME}, found ${callCount}`,
    });
  }
  if (brandConstructionCount !== 1) {
    violations.push({
      filePath: OWNING_FILE,
      lineNumber: 0,
      reason: `expected exactly 1 ${BRAND_NAME} assertion inside ${PRODUCER_NAME}, found ${brandConstructionCount}`,
    });
  }

  return { brandConstructionCount, callCount, declarationCount, violations };
}

async function main() {
  const { violations } = await findAssistantRunIdProducerViolations();

  if (violations.length === 0) {
    console.log(
      `Assistant runId provenance intact: one ${PRODUCER_NAME} producer, one ${BRAND_NAME} construction.`
    );
    return;
  }

  console.error(
    'Assistant runId provenance is what guarantees a thread-run row exists before the ' +
      'main-process run-event writes. See docs/agents/assistant-persistence.md ' +
      '§ RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP. Violations:'
  );
  for (const violation of violations) {
    console.error(`- ${violation.filePath}:${violation.lineNumber} — ${violation.reason}`);
  }
  process.exitCode = 1;
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  await main();
}
