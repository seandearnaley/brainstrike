import type { LanguageSupport } from '@codemirror/language';

export interface CodeSurfaceLanguageInput {
  readonly language?: string | undefined;
  readonly path?: string | undefined;
}

export interface CodeSurfaceLanguageResolution {
  readonly label: string;
  readonly loadSupport: (() => Promise<LanguageSupport | null>) | null;
  readonly source: 'explicit' | 'filename' | 'fallback';
}

const PLAIN_TEXT_LANGUAGE_NAMES = new Set(['plain', 'plaintext', 'plain text', 'text', 'txt']);
const FALLBACK_LANGUAGE: CodeSurfaceLanguageResolution = {
  label: 'Plain Text',
  loadSupport: null,
  source: 'fallback',
};
const EXPLICIT_LANGUAGE_LABELS = new Map<string, string>([
  ['c#', 'C#'],
  ['c++', 'C++'],
  ['go', 'Go'],
  ['java', 'Java'],
  ['javascript', 'JavaScript'],
  ['jsx', 'JSX'],
  ['kotlin', 'Kotlin'],
  ['markdown', 'Markdown'],
  ['php', 'PHP'],
  ['python', 'Python'],
  ['ruby', 'Ruby'],
  ['rust', 'Rust'],
  ['sql', 'SQL'],
  ['swift', 'Swift'],
  ['tsx', 'TSX'],
  ['typescript', 'TypeScript'],
]);
const EXTENSION_LANGUAGE_LABELS = new Map<string, string>([
  ['c', 'C'],
  ['cc', 'C++'],
  ['cs', 'C#'],
  ['css', 'CSS'],
  ['cpp', 'C++'],
  ['dart', 'Dart'],
  ['go', 'Go'],
  ['h', 'C'],
  ['hpp', 'C++'],
  ['htm', 'HTML'],
  ['html', 'HTML'],
  ['java', 'Java'],
  ['js', 'JavaScript'],
  ['json', 'JSON'],
  ['jsx', 'JSX'],
  ['kt', 'Kotlin'],
  ['less', 'Less'],
  ['lua', 'Lua'],
  ['md', 'Markdown'],
  ['php', 'PHP'],
  ['py', 'Python'],
  ['rb', 'Ruby'],
  ['rs', 'Rust'],
  ['sass', 'Sass'],
  ['scss', 'SCSS'],
  ['sh', 'Shell'],
  ['sql', 'SQL'],
  ['svelte', 'Svelte'],
  ['swift', 'Swift'],
  ['toml', 'TOML'],
  ['ts', 'TypeScript'],
  ['tsx', 'TSX'],
  ['vue', 'Vue'],
  ['xml', 'XML'],
  ['yaml', 'YAML'],
  ['yml', 'YAML'],
]);

export function resolveCodeSurfaceLanguage(
  input: CodeSurfaceLanguageInput
): CodeSurfaceLanguageResolution {
  const explicitLanguage = normalizeLanguageName(input.language);
  if (explicitLanguage) {
    if (PLAIN_TEXT_LANGUAGE_NAMES.has(explicitLanguage)) {
      return { ...FALLBACK_LANGUAGE, source: 'explicit' };
    }
    const explicitLabel = EXPLICIT_LANGUAGE_LABELS.get(explicitLanguage);
    if (explicitLabel) {
      return {
        label: explicitLabel,
        loadSupport: () => loadLanguageSupport({ language: explicitLanguage }),
        source: 'explicit',
      };
    }
  }

  const filename = input.path?.trim();
  if (filename) {
    const filenameLabel = resolveFilenameLanguageLabel(filename);
    if (filenameLabel) {
      return {
        label: filenameLabel,
        loadSupport: () => loadLanguageSupport({ path: filename }),
        source: 'filename',
      };
    }
    // Label unknown but CodeMirror's matchFilename has a comprehensive
    // registry that may still load grammar (e.g. for an extension we
    // haven't curated a display label for). Better to show "Plain Text"
    // with real highlighting than a labelled blank.
    return {
      label: FALLBACK_LANGUAGE.label,
      loadSupport: () => loadLanguageSupport({ path: filename }),
      source: 'filename',
    };
  }

  return FALLBACK_LANGUAGE;
}

function normalizeLanguageName(language: string | undefined): string | null {
  const normalized = language?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function resolveFilenameLanguageLabel(filename: string): string | null {
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension ? (EXTENSION_LANGUAGE_LABELS.get(extension) ?? null) : null;
}

async function loadLanguageSupport(
  input: CodeSurfaceLanguageInput
): Promise<LanguageSupport | null> {
  const [{ LanguageDescription }, { languages }] = await Promise.all([
    import('@codemirror/language'),
    import('@codemirror/language-data'),
  ]);
  const explicitLanguage = normalizeLanguageName(input.language);
  const description = explicitLanguage
    ? LanguageDescription.matchLanguageName(languages, explicitLanguage, true)
    : input.path
      ? LanguageDescription.matchFilename(languages, input.path)
      : null;
  return description ? description.load() : null;
}
