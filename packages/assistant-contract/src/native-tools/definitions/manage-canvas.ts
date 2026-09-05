import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { ManageCanvasInputSchema } from '../schemas/schemas-workspace.js';

// Like manageTaskList, this is DB-backed, versioned, and reversible rather
// than a workspace-file edit — but its create/update/rewrite actions PERSIST
// durable state, so it belongs in the 'edit' risk bucket (PR #2294 review):
// 'read' tools are allowed by default under permission enforcement and stay
// usable in plan mode, which would let the model write canvases while
// supposedly only planning. Consequences accepted: canvas completions enter
// the edit-activity stream (harmless refresh; the Canvas surface will want a
// signal anyway), and the read-only 'list' action rides the mutation
// classification until a split is warranted.
export const manageCanvas = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 220,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'edit',
  },
  description:
    'Create, list, or version-update a persisted HTML Canvas document for the current thread. update replaces oldString only when it occurs exactly once; rewrite replaces the whole HTML. Every change creates a new reversible version',
  discovery: { family: 'canvas documents', namespace: 'workspace' },
  id: 'brainstrike.manageCanvas',
  inputSchema: providerCompatibleInputSchema(ManageCanvasInputSchema),
  kind: 'desktop',
  returns:
    'Create/update/rewrite returns canvasId and new version; list returns each canvas latest version. Missing or non-unique matches return a structured error.',
  surfaces: ['desktop'],
});
