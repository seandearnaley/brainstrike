/**
 * A dynamic `import("pkg")` left bare in an emitted browser chunk throws
 * "Failed to resolve module specifier" when it runs: a browser resolves a bare
 * specifier only through an import map, and no Brainstrike page has one. A
 * `@vite-ignore` import escapes bundling exactly this way and still builds
 * (BST-2230: Settings' model download in both apps).
 */
const DYNAMIC_IMPORT = /\bimport\(\s*(['"`])([^'"`]+)\1\s*\)/gu;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/iu;

function isBare(specifier: string): boolean {
  return !(
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.includes('${') ||
    URL_SCHEME.test(specifier)
  );
}

/** The bare specifiers `code` imports dynamically, deduped and sorted. */
export function findBareDynamicImports(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[2];
    if (specifier !== undefined && isBare(specifier)) {
      found.add(specifier);
    }
  }
  return [...found].sort();
}

interface EmittedOutput {
  readonly code?: string;
  readonly fileName: string;
  readonly type: string;
}

/** Fails a browser build (page or worker) whose emitted chunks keep a bare dynamic import. */
export function browserBareDynamicImportGuardPlugin(): {
  readonly apply: 'build';
  generateBundle(
    this: { error(message: string): never },
    options: unknown,
    bundle: Readonly<Record<string, EmittedOutput>>
  ): void;
  readonly name: string;
} {
  return {
    apply: 'build',
    generateBundle(_options, bundle) {
      const violations = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk' && output.code !== undefined
          ? findBareDynamicImports(output.code).map(
              (specifier) => `${output.fileName}: import(${JSON.stringify(specifier)})`
            )
          : []
      );
      if (violations.length > 0) {
        this.error(
          `Browser chunks keep bare dynamic imports, which fail at runtime without an import map. Bundle the module or load it in the realm that owns it:\n${violations.join('\n')}`
        );
      }
    },
    name: 'brainstrike:browser-bare-dynamic-import-guard',
  };
}
