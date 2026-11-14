import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { MemoryInputSchema } from '../schemas/schemas-memory.ts';

// ADR-0040: the project's memory, Anthropic's memory tool commands over
// /memories as a function tool on every provider. Risk 'read', as working
// memory was: it writes only the app's own notes for the project, never the
// workspace, so it never asks. Critical: a run that has memory loads its
// index, so the tool that reads and writes the notes is always there with it.
export const memory = defineNativeTool({
  activity: {
    active: 'Using memory',
    done: 'Used memory',
    family: 'memory',
    request: 'Use memory',
    targetArg: ['path', 'new_path'],
  },
  defaults: {
    category: 'action',
    estimatedTokens: 260,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    "This project's notes, as files under /memories. The app keeps /memories/MEMORY.md, the index in your instructions; never write it. view lists or reads (view_range pages); create writes a note, `# Title` first; str_replace and insert edit; delete and rename. One fact per note; never task progress or secrets",
  display: {
    command: 'view, create, str_replace, insert, delete or rename, as in Anthropic’s memory tool.',
    path: 'The note or directory, under /memories.',
  },
  id: 'brainstrike.memory',
  inputSchema: effectToolInputSchema(MemoryInputSchema),
  kind: 'desktop',
  returns:
    'Anthropic’s memory tool result text: a directory listing, a note with line numbers, or what changed. A write is shown in the thread as a card with Undo.',
  surfaces: ['desktop'],
});
