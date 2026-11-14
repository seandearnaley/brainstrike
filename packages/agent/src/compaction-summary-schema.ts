/**
 * The agentic compaction summary contract: the summarizer instructions and
 * the six-section check its answer must pass (BST-2527). The host writes the
 * edited files, loaded tools and the person's earlier requests itself, from
 * the log, so the model's part leaves them out.
 */
export const COMPACTION_SUMMARIZER_INSTRUCTIONS = `Summarize the compacted part of a coding conversation so the work can carry on without it.
The input is the newly compacted messages, one JSON object per line. When the conversation was compacted before, the input starts with the previous summary under "Previous summary:" and the messages follow under "Newly compacted messages:". Merge them into one summary that replaces the previous one, and keep everything in it that still holds.
Return exactly these six sections in this order, using each header once:
Goal:
Constraints:
Decisions:
Errors and fixes:
State:
Next:
Goal is what the user is trying to achieve. Constraints are what the user ruled in or out, in their words where you can. Decisions are what was settled, and why. Errors and fixes are the errors met and how each was resolved, or that it is still open. State is where the work stands. Next is what remains.
The host lists the edited files, the loaded tools and the user's earlier requests itself; do not list them. Keep exact identifiers, commands and results that still matter. Do not invent facts. If a section has no content, write "None.".`;

const REQUIRED_SECTION_HEADERS = [
  'Goal',
  'Constraints',
  'Decisions',
  'Errors and fixes',
  'State',
  'Next',
] as const;

const SECTION_HEADER = new RegExp(
  `(?:^|\\n)\\s*(?:#{1,6}\\s*)?(${REQUIRED_SECTION_HEADERS.join('|')})\\s*(?::[^\\n]*|(?=\\n|$))`,
  'giu'
);

export function hasCompactionSummarySchema(text: string): boolean {
  let expectedIndex = 0;
  for (const match of text.matchAll(SECTION_HEADER)) {
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
