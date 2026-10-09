/**
 * The agentic compaction summary contract: the summarizer instructions and
 * the five-section check its answer must pass. Pure, so the CLI-first host and
 * the legacy Mastra summarizer share one owner.
 */
export const COMPACTION_SUMMARIZER_INSTRUCTIONS = `Create a concise conversation state summary from the projected transcript.
Return exactly these five sections in this order, using each header once:
Goal:
State:
Decisions:
Next:
Files touched:
Preserve concrete constraints, unresolved questions, commands/results that still matter, and exact file paths. Do not invent facts. If a section has no content, write "None.".`;

const REQUIRED_SECTION_HEADERS = ['Goal', 'State', 'Decisions', 'Next', 'Files touched'] as const;

export function hasCompactionSummarySchema(text: string): boolean {
  let expectedIndex = 0;
  for (const match of text.matchAll(
    /(?:^|\n)\s*(?:#{1,6}\s*)?(Goal|State|Decisions|Next|Files touched)\s*(?::[^\n]*|(?=\n|$))/gi
  )) {
    const header = match[1]?.toLowerCase();
    const headerIndex = REQUIRED_SECTION_HEADERS.findIndex(
      (required) => required.toLowerCase() === header
    );
    if (headerIndex === expectedIndex) {
      expectedIndex += 1;
    } else if (headerIndex > expectedIndex) {
      return false;
    }
  }
  return expectedIndex === REQUIRED_SECTION_HEADERS.length;
}
