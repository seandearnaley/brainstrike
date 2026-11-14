/**
 * The agentic compaction summary contract: what the host asks the run's own
 * model at the end of its next request, and the six-section check its answer
 * must pass (BST-2527, BST-2532). The host writes the edited files, loaded
 * tools and the person's earlier requests itself, from the log, so the
 * model's part leaves them out.
 */
export const COMPACTION_SUMMARIZER_INSTRUCTIONS = `Brainstrike is compacting this conversation: its older part will be replaced by a summary, and its newest messages stay as they are. Reply with that summary of the whole conversation above, and call no tool.
If the conversation opens with an earlier compaction notice, merge its summary into yours and keep everything in it that still holds.
Return exactly these six sections in this order, using each header once:
Goal:
Constraints:
Decisions:
Errors and fixes:
State:
Next:
Goal is what the user is trying to achieve. Constraints are what the user ruled in or out, in their words where you can. Decisions are what was settled, and why. Errors and fixes are the errors met and how each was resolved, or that it is still open. State is where the work stands. Next is what remains.
Brainstrike lists the edited files, the loaded tools and the user's earlier requests itself; do not list them. Keep exact identifiers, commands and results that still matter. Do not invent facts. If a section has no content, write "None.".`;

const REQUIRED_SECTION_HEADERS = [
  'Goal',
  'Constraints',
  'Decisions',
  'Errors and fixes',
  'State',
  'Next',
] as const;

/** A header on its own line: plain, a Markdown heading, or bold (`**Goal:**`, `**Goal**:`). */
const SECTION_HEADER = new RegExp(
  `(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\*\\*|__)?(${REQUIRED_SECTION_HEADERS.join('|')})(?:\\*\\*|__)?\\s*(?::[^\\n]*|(?=\\n|$))`,
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
