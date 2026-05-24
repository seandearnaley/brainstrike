import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export interface CodeSurfaceLanguageInput {
  readonly language?: string | undefined;
  readonly path?: string | undefined;
}

export interface CodeSurfaceLanguageResolution {
  readonly description: LanguageDescription | null;
  readonly label: string;
  readonly source: 'explicit' | 'filename' | 'fallback';
}

const PLAIN_TEXT_LANGUAGE_NAMES = new Set(['plain', 'plaintext', 'plain text', 'text', 'txt']);
const FALLBACK_LANGUAGE: CodeSurfaceLanguageResolution = {
  description: null,
  label: 'Plain Text',
  source: 'fallback',
};

export function resolveCodeSurfaceLanguage(
  input: CodeSurfaceLanguageInput
): CodeSurfaceLanguageResolution {
  const explicitLanguage = normalizeLanguageName(input.language);
  if (explicitLanguage) {
    if (PLAIN_TEXT_LANGUAGE_NAMES.has(explicitLanguage)) {
      return { ...FALLBACK_LANGUAGE, source: 'explicit' };
    }
    const explicitMatch = LanguageDescription.matchLanguageName(languages, explicitLanguage, true);
    if (explicitMatch) {
      return {
        description: explicitMatch,
        label: explicitMatch.name,
        source: 'explicit',
      };
    }
  }

  const filename = input.path?.trim();
  if (filename) {
    const filenameMatch = LanguageDescription.matchFilename(languages, filename);
    if (filenameMatch) {
      return {
        description: filenameMatch,
        label: filenameMatch.name,
        source: 'filename',
      };
    }
  }

  return FALLBACK_LANGUAGE;
}

function normalizeLanguageName(language: string | undefined): string | null {
  const normalized = language?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}
