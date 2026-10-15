import { KIND_LABEL } from './context-map-kinds';
import type { ContextFileRow } from './context-map-model';
import { isLive } from './context-map-model';

function fence(lines: readonly string[]): string {
  const body = lines.join('\n');
  let ticks = 3;
  for (const run of body.match(/`+/gu) ?? []) {
    ticks = Math.max(ticks, run.length + 1);
  }
  const marker = '`'.repeat(ticks);
  return `${marker}\n${body}\n${marker}`;
}

/**
 * The selected turn's in-window file context as Markdown: each file's spans,
 * with the delivered text where the tool returned it. Spans without delivered
 * text (semantic excerpts, edits, attachments) are listed by their lines.
 */
export function contextBundleMarkdown(rows: readonly ContextFileRow[], turn: number): string {
  const sections = [`# Thread context at turn ${turn}`];
  for (const row of rows) {
    const live = row.spans.filter((entry) => isLive(entry.at.state));
    if (live.length === 0) {
      continue;
    }
    sections.push(`## ${row.rootName ? `${row.rootName}/` : ''}${row.path}`);
    for (const { at, span } of live) {
      const lines =
        span.startLine === undefined
          ? span.wholeFile
            ? 'whole file'
            : 'lines unknown'
          : `lines ${span.startLine}–${span.endLine}`;
      sections.push(`${KIND_LABEL[span.kind]}, ${lines} (turn ${at.turn})`);
      if (span.deliveredLines && span.deliveredLines.length > 0) {
        sections.push(fence(span.deliveredLines));
      }
    }
  }
  return `${sections.join('\n\n')}\n`;
}
