import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * `packages/db` cannot import the desktop resolver, so the snapshot manifest states its own rule for
 * `profile`. This test parses both source files with the repo's `typescript`, takes the resolver's
 * `toProfileSegment` declaration, compiles it with `ts.transpileModule` (the compiler removes every
 * annotation and cast), runs it over a corpus, and requires the manifest's rule to accept everything
 * it produces, so a snapshot of any desktop profile is never listed as invalid. It fails loudly when
 * the function is missing or uses a free name other than `PROFILE_SEGMENT_MAX_LENGTH` (or a standard
 * global). The reserved-device-name half is `windows-reserved-device-name-twin.test.mjs`.
 */
const parse = (file, text = readFileSync(path.join(repoRoot, file), 'utf8')) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

const STANDARD_GLOBALS = new Set(['Array', 'Math', 'Number', 'Object', 'String']);

/** The initializer of a top-level `const name = <literal>;`. */
function constantInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(sourceFile) === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  assert.fail(`${sourceFile.fileName} declares no const ${name}`);
}

const numberConstant = (sourceFile, name) => {
  const initializer = constantInitializer(sourceFile, name);
  assert.ok(ts.isNumericLiteral(initializer), `${name} is not a numeric literal`);
  return Number(initializer.text);
};

const regexConstant = (sourceFile, name) => {
  const initializer = constantInitializer(sourceFile, name);
  assert.ok(
    ts.isRegularExpressionLiteral(initializer),
    `${name} is not a regular expression literal`
  );
  const [, pattern, flags] = /^\/(.*)\/([a-z]*)$/su.exec(initializer.text);
  return new RegExp(pattern, flags);
};

/** Names a function body uses that it neither declares nor receives: what it would need from module scope. */
function freeNames(fn, sourceFile) {
  const declared = new Set(fn.parameters.map((parameter) => parameter.name.getText(sourceFile)));
  const used = new Set();
  const visit = (node) => {
    if (ts.isTypeNode(node)) {
      return; // types are compiled away
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declared.add(node.name.text);
    } else if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isMemberName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isDeclarationName = ts.isVariableDeclaration(parent) && parent.name === node;
      if (!(isMemberName || isDeclarationName)) {
        used.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return [...used].filter((name) => !(declared.has(name) || STANDARD_GLOBALS.has(name)));
}

/** Compiles the named top-level function of `sourceFile`, supplying `PROFILE_SEGMENT_MAX_LENGTH`. */
function loadFunction(sourceFile, name, maxLength) {
  const fn = sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  assert.ok(fn?.body, `${sourceFile.fileName} declares no function ${name}`);
  const unexpected = freeNames(fn, sourceFile).filter(
    (free) => free !== 'PROFILE_SEGMENT_MAX_LENGTH'
  );
  assert.deepEqual(unexpected, [], `${name} uses unexpected free names`);
  const { outputText } = ts.transpileModule(fn.getText(sourceFile), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return new Function('PROFILE_SEGMENT_MAX_LENGTH', `${outputText}\nreturn ${name};`)(maxLength);
}

const desktop = parse('packages/assistant-service/src/node-workspace/database-location.ts');
const manifest = parse('packages/db/src/database-snapshot-manifest.ts');
const desktopMaxLength = numberConstant(desktop, 'PROFILE_SEGMENT_MAX_LENGTH');
const manifestMaxLength = numberConstant(manifest, 'PATH_SEGMENT_MAX_LENGTH');
const profilePattern = regexConstant(manifest, 'PROFILE_PATTERN');
const produce = loadFunction(desktop, 'toProfileSegment', desktopMaxLength);

/** A small deterministic generator, so a failure names the same input every run. */
function corpus() {
  const alphabet = 'abcXYZ019 ._-/\\é🙂';
  let seed = 1_234_567;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed;
  };
  const generated = Array.from({ length: 2000 }, () =>
    Array.from({ length: next() % 90 }, () => alphabet[next() % alphabet.length]).join('')
  );
  return [
    '_x',
    '__',
    'X.partial',
    ' Feature/X y ',
    '.hidden',
    '-lead',
    `${'a'.repeat(63)}.b`,
    'a'.repeat(200),
    ...generated,
  ];
}

test('the manifest and the desktop resolver agree on the profile length limit', () => {
  assert.equal(manifestMaxLength, desktopMaxLength);
});

test('every profile the desktop resolver can produce is a valid manifest profile', () => {
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
  for (const raw of corpus()) {
    const profile = produce(raw);
    if (profile === '' || reserved.test(profile)) {
      continue; // the resolver refuses these for an override, and the manifest refuses them too
    }
    assert.ok(profilePattern.test(profile), `${JSON.stringify(raw)} -> ${JSON.stringify(profile)}`);
    assert.ok(profile.length <= manifestMaxLength, `${JSON.stringify(profile)} is too long`);
    assert.ok(!profile.endsWith('.'), `${JSON.stringify(profile)} ends in a dot`);
  }
});

test('the manifest profile pattern still rejects what the resolver never produces', () => {
  for (const bad of ['.x', '-x', 'X', 'a b', 'a/b', '']) {
    assert.ok(!profilePattern.test(bad), JSON.stringify(bad));
  }
});

test('the loader compiles a function whose body has annotations and casts', () => {
  const source = parse(
    'inline.ts',
    `function toProfileSegment(raw: string): string {
       const trimmed: string = (raw as string).trim();
       return (trimmed satisfies string).slice(0, PROFILE_SEGMENT_MAX_LENGTH);
     }`
  );
  assert.equal(loadFunction(source, 'toProfileSegment', 3)(' abcdef '), 'abc');
});

test('the loader fails loudly for a missing function and for a free name it cannot supply', () => {
  assert.throws(
    () => loadFunction(parse('inline.ts', 'const x = 1;'), 'toProfileSegment', 3),
    /declares no function/u
  );
  const helper = parse(
    'inline.ts',
    'function toProfileSegment(raw: string): string { return normalise(raw); }'
  );
  assert.throws(() => loadFunction(helper, 'toProfileSegment', 3), /unexpected free names/u);
});
