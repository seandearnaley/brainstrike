import {
  MCP_HOST_DIAGNOSTIC_MAX_ENTRIES,
  type McpHostDiagnostic,
} from '@brainstrike/assistant-contract';
import { scrubLikelySecretValues } from '@brainstrike/utils/diagnostics';
import stripAnsi from 'strip-ansi';

export const MCP_STDIO_DIAGNOSTIC_MAX_ENTRIES = MCP_HOST_DIAGNOSTIC_MAX_ENTRIES;
export const MCP_STDIO_DIAGNOSTIC_MAX_MESSAGE_CHARS = 512;
const MAX_BUFFERED_LINE_CHARS = 8192;
const TRUNCATION_MARKER = '…[truncated]';
const URL_PATTERN = /https?:\/\/[^\s?#]+(?:\?[^\s#]*)?(?:#[^\s]*)?/giu;
const OAUTH_PARAMETER_PATTERN =
  /\b(?:authorization_code|access_token|refresh_token|code|code_verifier|verifier|state)=([^&\s]+)/giu;
const LINE_UNSAFE_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function redactUrl(value: string): string {
  return value.replace(URL_PATTERN, (candidate) => {
    try {
      const url = new URL(candidate);
      if (!(url.search || url.hash)) {
        return candidate;
      }
      return `${url.origin}${url.pathname}?[redacted-query]`;
    } catch {
      return '[redacted-auth-url]';
    }
  });
}

function boundMessage(value: string): { message: string; truncated: boolean } {
  if (value.length <= MCP_STDIO_DIAGNOSTIC_MAX_MESSAGE_CHARS) {
    return { message: value, truncated: false };
  }
  return {
    message: `${value.slice(
      0,
      MCP_STDIO_DIAGNOSTIC_MAX_MESSAGE_CHARS - TRUNCATION_MARKER.length
    )}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

export function sanitizeStdioDiagnosticLine(raw: string): McpHostDiagnostic | null {
  const lineSafe = stripAnsi(raw).replace(LINE_UNSAFE_PATTERN, '�').trim();
  if (lineSafe.length === 0) {
    return null;
  }
  const oauthRedacted = redactUrl(lineSafe).replace(
    OAUTH_PARAMETER_PATTERN,
    (match) => `${match.slice(0, match.indexOf('=') + 1)}[redacted-oauth-parameter]`
  );
  const scrubbed = scrubLikelySecretValues(oauthRedacted).text;
  const bounded = boundMessage(scrubbed);
  return Object.freeze({
    message: bounded.message,
    stream: 'stderr' as const,
    truncated: bounded.truncated,
  });
}

export class McpStdioDiagnosticCollector {
  private buffer = '';
  private droppedBufferedChars = 0;
  private readonly retained: McpHostDiagnostic[] = [];

  constructor(private readonly onDiagnostic?: (diagnostic: McpHostDiagnostic) => void) {}

  flush(): void {
    if (this.buffer.length === 0 && this.droppedBufferedChars === 0) {
      return;
    }
    this.emitLine(this.buffer);
    this.buffer = '';
    this.droppedBufferedChars = 0;
  }

  snapshot(): readonly McpHostDiagnostic[] {
    return structuredClone(this.retained);
  }

  write(chunk: string): void {
    const pieces = chunk.split(/\r\n|\r|\n/u);
    this.append(pieces.shift() ?? '');
    for (const piece of pieces) {
      this.emitLine(this.buffer);
      this.buffer = '';
      this.droppedBufferedChars = 0;
      this.append(piece);
    }
  }

  private append(value: string): void {
    const remaining = MAX_BUFFERED_LINE_CHARS - this.buffer.length;
    if (remaining > 0) {
      this.buffer += value.slice(0, remaining);
    }
    this.droppedBufferedChars += Math.max(0, value.length - Math.max(remaining, 0));
  }

  private emitLine(raw: string): void {
    const withMarker =
      this.droppedBufferedChars > 0 ? `${raw}…[${this.droppedBufferedChars} chars omitted]` : raw;
    const diagnostic = sanitizeStdioDiagnosticLine(withMarker);
    if (!diagnostic) {
      return;
    }
    this.retained.push(diagnostic);
    if (this.retained.length > MCP_STDIO_DIAGNOSTIC_MAX_ENTRIES) {
      this.retained.splice(0, this.retained.length - MCP_STDIO_DIAGNOSTIC_MAX_ENTRIES);
    }
    this.onDiagnostic?.(diagnostic);
  }
}
