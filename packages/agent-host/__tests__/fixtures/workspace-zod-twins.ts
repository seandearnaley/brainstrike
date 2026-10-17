import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import {
  CANVAS_HTML_MAX_BYTES,
  canvasHtmlWithinByteCeiling,
} from '@brainstrike/assistant-contract/mastra-memory-schema';
import { z } from 'zod';

// ============================================================================
// Workspace Tool Schemas
// ============================================================================

const ROOT_QUALIFIER_DESCRIPTION =
  "Open-folder name/id. Omit for this thread's primary folder; an explicit root always wins.";

/**
 * A canvas HTML field, bounded by UTF-8 BYTES rather than by whatever unit the
 * installed Zod happens to count.
 *
 * The workspace-file fields below deliberately do NOT do this, and the
 * difference is the point: they sit above an authoritative ~2 MB byte cap in
 * the desktop tool, so their `.max()` is an outer guard well above the real
 * limit and its unit is irrelevant. `manage-canvas-tool.ts` has no size
 * enforcement of its own, so for canvas the only ceilings are this schema and
 * the composed-result check in the desktop canvas repository.
 *
 * `.max()` alone does not deliver a byte bound. Zod counts CODE POINTS (4.5;
 * UTF-16 code units before that), so `.max(8_000_000)` admits eight million
 * astral characters — 31 MB of UTF-8, four times the documented limit, and
 * double what the same line admitted under Zod 4.4. It is kept because it is
 * what puts `maxLength` in the emitted JSON Schema, NOT as a short-circuit:
 * measured on Zod 4.5, a string failing `.max()` still reaches the refinement,
 * because 4 runs checks non-abortively. The refinement is the authority and is
 * always reached.
 *
 * `minLength` is a PARAMETER rather than something a caller chains on for one
 * empirical reason: expressing the non-empty constraint as a second refinement
 * drops `minLength: 1` from the emitted JSON Schema — refinements are not
 * representable there — which silently narrows what the MODEL is told while
 * leaving parsing unchanged. That moved the recorded native-tool prompt budget
 * and failed `native-tool-prompt-budget.test.ts`. (It is NOT because `.refine()`
 * blocks chaining: under Zod 4 it returns the same ZodString and `.min()`
 * chains fine. Zod 3's ZodEffects behaviour no longer applies.)
 */
function canvasHtml(options?: { readonly minLength?: number }) {
  const bounded =
    options?.minLength === undefined
      ? z.string().max(CANVAS_HTML_MAX_BYTES)
      : z.string().min(options.minLength).max(CANVAS_HTML_MAX_BYTES);
  return bounded.refine(canvasHtmlWithinByteCeiling, {
    message: `canvas HTML exceeds ${CANVAS_HTML_MAX_BYTES} UTF-8 bytes`,
  });
}
const CANVAS_TITLE_MAX = 500;

// Branches deliberately STRIP (zod default) rather than `.strict()`:
// `action` fully determines semantics, and real models bundle fields from
// other actions (observed live with gpt-5.6, 2026-08-07 — a valid `create`
// carrying redundant canvasId/oldString/newString was rejected, breaking the
// feature and burning retry tokens). Cross-action extras among the six
// DECLARED envelope keys are harmless; genuinely unknown keys (hallucinated
// API) are still rejected by the `.strict()` provider envelope below.
const ManageCanvasActionInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    html: canvasHtml().describe('Initial HTML content for version 1 (max 8 MB of UTF-8)'),
    title: z.string().min(1).max(CANVAS_TITLE_MAX).describe('Canvas document title'),
  }),
  z.object({
    action: z.literal('update'),
    canvasId: z.string().min(1).describe('Canvas document id'),
    newString: canvasHtml().describe(
      'Replacement HTML substring; empty deletes the match (max 8 MB of UTF-8)'
    ),
    oldString: canvasHtml({ minLength: 1 }).describe(
      'Exact HTML substring that must occur exactly once in the latest version'
    ),
  }),
  z.object({
    action: z.literal('rewrite'),
    canvasId: z.string().min(1).describe('Canvas document id'),
    html: canvasHtml().describe('Complete HTML content for the new version (max 8 MB of UTF-8)'),
  }),
  z.object({ action: z.literal('list') }),
]);

export type ManageCanvasInput = z.infer<typeof ManageCanvasActionInputSchema>;

/**
 * Narrow an envelope-validated input to its clean action-branch shape,
 * STRIPPING tolerated cross-action extras so the executor and repository
 * receive exactly the union type they're written against — no `as` cast, no
 * extras flowing into repository inputs. The envelope's superRefine already
 * proved this parse succeeds; a failure here is a wiring bug and throws.
 */
export function normalizeManageCanvasInput(input: unknown): ManageCanvasInput {
  return ManageCanvasActionInputSchema.parse(input);
}

/**
 * Provider schemas must be root JSON objects; a raw Zod discriminated union
 * serializes as a root `oneOf` and is rejected by the native-tool prompt
 * contract. Keep the provider envelope strict and delegate its conditional
 * field validation to the canonical action union above.
 */
export const ManageCanvasInputSchema = z
  .object({
    action: z.enum(['create', 'update', 'rewrite', 'list']).describe('Canvas operation'),
    canvasId: z.string().min(1).optional().describe('Required for update and rewrite'),
    html: canvasHtml()
      .optional()
      .describe('Complete HTML; required for create and rewrite (max 8 MB of UTF-8)'),
    newString: canvasHtml()
      .optional()
      .describe('Update replacement; may be empty (max 8 MB of UTF-8)'),
    oldString: canvasHtml({ minLength: 1 })
      .optional()
      .describe('Update target; must occur exactly once'),
    title: z.string().min(1).max(CANVAS_TITLE_MAX).optional().describe('Required for create'),
  })
  .strict()
  .superRefine((input, context) => {
    const parsed = ManageCanvasActionInputSchema.safeParse(input);
    if (parsed.success) {
      return;
    }
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
    }
  });

export const ReadWorkspaceFileInputSchema = z
  .object({
    cursor: z
      .string()
      .regex(/^rfh_[A-Za-z0-9_-]{22}$/)
      .nullish()
      .describe(
        'Short nextCursor handle from the previous page. Pass it unchanged with optional maxChars and omit every other field'
      ),
    endLine: z
      .number()
      .int()
      .positive()
      .nullish()
      .describe(
        'Last 1-based line; omit with cursor unless replaying the original value unchanged'
      ),
    maxChars: z.number().int().positive().max(50_000).nullish().describe('Output character cap'),
    path: z
      .string()
      .min(1)
      .nullish()
      .describe('Workspace-relative file path; required only when starting a new read'),
    root: z.string().nullish().describe(ROOT_QUALIFIER_DESCRIPTION),
    startLine: z
      .number()
      .int()
      .positive()
      .nullish()
      .describe(
        'First 1-based line; omit with cursor unless replaying the original value unchanged'
      ),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.cursor) {
      for (const field of ['path', 'root'] as const) {
        if (input[field] !== null && input[field] !== undefined) {
          context.addIssue({
            code: 'custom',
            message: `Omit ${field} when continuing with cursor`,
            path: [field],
          });
        }
      }
      return;
    }
    if (!input.path) {
      context.addIssue({
        code: 'custom',
        message: 'path is required when starting a new read',
        path: ['path'],
      });
    }
  });

export type ReadWorkspaceFileInput = z.infer<typeof ReadWorkspaceFileInputSchema>;

export const WriteWorkspaceFileInputSchema = z
  .object({
    content: z
      // Outer DoS guard only; the desktop tool enforces the authoritative ~2 MB
      // UTF-8 BYTE cap. This counts CODE POINTS (Zod 4.5; UTF-16 code units
      // before that) and sits well above the real cap either way, which is why
      // the unit does not matter HERE the way it does for canvas above.
      .string()
      .max(8_000_000)
      .describe('Full UTF-8 content (up to ~2 MB); overwrites an existing file'),
    path: z.string().min(1).describe('Workspace-relative path; creates missing parent directories'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type WriteWorkspaceFileInput = z.infer<typeof WriteWorkspaceFileInputSchema>;

export const StringReplaceWorkspaceFileInputSchema = z
  .object({
    newStr: z.string().max(8_000_000).describe('Replacement text; empty deletes the matched block'),
    oldStr: z
      // Outer DoS guard only; the desktop tool reads the file under the same
      // ~2 MB BYTE cap as readWorkspaceFile. This counts CODE POINTS (Zod 4.5;
      // UTF-16 code units before that), well above that cap either way.
      .string()
      .min(1)
      .max(8_000_000)
      .describe(
        'Existing text block. Use whole lines and enough context to identify one location; ambiguous matches are refused.'
      ),
    path: z.string().min(1).describe('Existing workspace-relative file path'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type StringReplaceWorkspaceFileInput = z.infer<typeof StringReplaceWorkspaceFileInputSchema>;

export const DeleteWorkspaceFileInputSchema = z
  .object({
    path: z.string().min(1).describe('Workspace-relative file path; directories are refused'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type DeleteWorkspaceFileInput = z.infer<typeof DeleteWorkspaceFileInputSchema>;

export const RenameWorkspaceFileInputSchema = z
  .object({
    fromPath: z.string().min(1).describe('Existing workspace-relative source file'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
    toPath: z
      .string()
      .min(1)
      .describe('Destination path in the same root; no overwrite; creates missing parents'),
  })
  .strict();

export type RenameWorkspaceFileInput = z.infer<typeof RenameWorkspaceFileInputSchema>;

export const ReadWorkspaceDirectoryInputSchema = z
  .object({
    depth: z.number().int().min(0).max(5).optional().describe('Traversal depth (max 5)'),
    detail: z.boolean().optional().describe('Include entry size/depth (default false)'),
    includeDirectories: z.boolean().optional().describe('Include directories'),
    includeFiles: z.boolean().optional().describe('Include files'),
    includeHidden: z.boolean().optional().describe('Include hidden entries'),
    maxEntries: z.number().int().positive().max(500).optional().describe('Entry cap'),
    offset: z.number().int().min(0).max(5000).optional().describe('Pagination offset'),
    path: z.string().optional().describe('Directory path (default root)'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type ReadWorkspaceDirectoryInput = z.infer<typeof ReadWorkspaceDirectoryInputSchema>;

export const FindWorkspaceSymbolInputSchema = z
  .object({
    contextLines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe('Preview lines before/after each match (default 2)'),
    maxMatches: z.number().int().positive().max(20).optional().describe('Max matches (default 5)'),
    path: z.string().min(1).describe('Workspace-relative file path'),
    query: z.string().min(1).describe('Symbol name or substring to find'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
  })
  .strict();

export type FindWorkspaceSymbolInput = z.infer<typeof FindWorkspaceSymbolInputSchema>;

/** The listing takes no input: it reports the open roots and the index. */
export const ListWorkspaceContextInputSchema = z.object({}).strict();

export type ListWorkspaceContextInput = z.infer<typeof ListWorkspaceContextInputSchema>;

export const ReadWorkspaceContextInputSchema = z
  .object({
    filePaths: z
      .array(z.string().min(1))
      .min(1)
      .max(5000)
      .describe('Workspace-relative file paths to read'),
    maxCharsPerFile: z
      .number()
      .int()
      .positive()
      .max(50_000)
      .optional()
      .describe('Per-file character cap'),
    maxFiles: z.number().int().positive().max(500).optional().describe('File count cap'),
    root: z.string().optional().describe(ROOT_QUALIFIER_DESCRIPTION),
    tokenBudget: z
      .number()
      .int()
      .positive()
      .max(200_000)
      .optional()
      .describe('Total output token cap'),
  })
  .strict();

export type ReadWorkspaceContextInput = z.infer<typeof ReadWorkspaceContextInputSchema>;

export const workspaceZodTwins = [
  [NATIVE_TOOL_ID.manageCanvas, ManageCanvasInputSchema],
  [NATIVE_TOOL_ID.readWorkspaceFile, ReadWorkspaceFileInputSchema],
  [NATIVE_TOOL_ID.writeWorkspaceFile, WriteWorkspaceFileInputSchema],
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile, StringReplaceWorkspaceFileInputSchema],
  [NATIVE_TOOL_ID.deleteWorkspaceFile, DeleteWorkspaceFileInputSchema],
  [NATIVE_TOOL_ID.renameWorkspaceFile, RenameWorkspaceFileInputSchema],
  [NATIVE_TOOL_ID.readWorkspaceDirectory, ReadWorkspaceDirectoryInputSchema],
  [NATIVE_TOOL_ID.findWorkspaceSymbol, FindWorkspaceSymbolInputSchema],
  [NATIVE_TOOL_ID.listWorkspaceContext, ListWorkspaceContextInputSchema],
  [NATIVE_TOOL_ID.readWorkspaceContext, ReadWorkspaceContextInputSchema],
  ['skill', z.object({ name: z.string() })],
  [
    'skill_read',
    z.object({
      endLine: z.number().optional(),
      path: z.string(),
      skillName: z.string(),
      startLine: z.number().optional(),
    }),
  ],
  [
    'skill_search',
    z.object({
      query: z.string(),
      skillNames: z.array(z.string()).optional(),
      topK: z.number().optional(),
    }),
  ],
] as const;
