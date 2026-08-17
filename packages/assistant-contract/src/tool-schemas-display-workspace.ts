/**
 * Workspace Tool Schema Display Metadata
 *
 * Browser-safe parameter definitions for native workspace tools.
 */

import type { NativeToolId } from './native-tool-catalog.js';
import type { ToolSchemaDisplay } from './tool-schemas-display.js';

export const WORKSPACE_TOOL_SCHEMAS = {
  'brainstrike.deleteWorkspaceFile': {
    description:
      'Delete a single file from the selected workspace root. FILES ONLY — a directory path is refused (use executeCommand for directory removal). Workspace-scoped: the path can never escape the open folder. Removes the file from the workspace index when it was indexed. Requires approval (edit-risk).',
    parameters: [
      {
        description: 'Workspace-relative file path to delete (the file must already exist)',
        minLength: 1,
        name: 'path',
        required: true,
        type: 'string',
      },
      {
        description:
          'Folder name or id to delete from when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Delete result: ok: true, the normalized workspace path, rootName, and indexInvalidated (true when the file had workspace-index rows that were removed)',
    toolId: 'brainstrike.deleteWorkspaceFile',
  },

  'brainstrike.listWorkspaceContext': {
    description:
      'Inspect the open workspace roots, the selected context, and the workspace index hint without returning file contents. Lists every open folder (name + id) so you can pass a `root` qualifier to the read/search tools. Compact summary by default; detail: true adds per-file Tapestry ranges. Use this before reading selected files.',
    parameters: [
      {
        default: false,
        description:
          'Include full curated-context metadata with per-file Tapestry ranges (default: compact summary)',
        name: 'detail',
        required: false,
        type: 'boolean',
      },
      {
        default: 0,
        description: 'Skip this many selected file paths to continue a truncated listing',
        max: 10_000,
        min: 0,
        name: 'offset',
        required: false,
        type: 'number',
      },
      {
        default: false,
        description: 'Include selected-file token estimates when they are already available',
        name: 'includeTokenEstimates',
        required: false,
        type: 'boolean',
      },
    ],
    returns:
      'Open workspace roots (workspaceRoots: name + id + path), the main root path, selected paths, selected count, workspace index hint, and optional metadata',
    toolId: 'brainstrike.listWorkspaceContext',
  },

  'brainstrike.manageCanvas': {
    description:
      'Create, list, or write a new version of an HTML Canvas document persisted for the current thread.',
    parameters: [
      {
        description:
          'Operation: create a document, update one exact unique substring, rewrite all HTML, or list current documents',
        enumValues: ['create', 'update', 'rewrite', 'list'],
        name: 'action',
        required: true,
        type: 'enum',
      },
      {
        description: 'Canvas document id; required for update and rewrite',
        minLength: 1,
        name: 'canvasId',
        required: false,
        type: 'string',
      },
      {
        description: 'Canvas title; required for create',
        minLength: 1,
        name: 'title',
        required: false,
        type: 'string',
      },
      {
        description: 'Complete HTML; required for create and rewrite',
        name: 'html',
        required: false,
        type: 'string',
      },
      {
        description: 'Exact substring that must occur once; required for update',
        minLength: 1,
        name: 'oldString',
        required: false,
        type: 'string',
      },
      {
        description: 'Replacement substring; required for update and may be empty',
        name: 'newString',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Create/update/rewrite returns canvasId and new version; list returns each canvas latest version. Missing or non-unique matches return a structured error.',
    toolId: 'brainstrike.manageCanvas',
  },

  'brainstrike.readWorkspaceContext': {
    description:
      'Read selected or explicit workspace files under bounded file, per-file, and token limits. Use after semantic retrieval when exact source is needed.',
    parameters: [
      {
        arrayItemType: 'string',
        description: 'Workspace-relative file paths to read. Defaults to selected context files.',
        name: 'filePaths',
        required: false,
        type: 'array',
      },
      {
        description:
          'Folder name or id to read from when multiple folders are open (omit when one). Requires explicit filePaths — the selected-context default only applies to the focused folder.',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        default: 4000,
        description: 'Maximum approximate output tokens for all returned file contents',
        max: 200_000,
        min: 1,
        name: 'tokenBudget',
        required: false,
        type: 'number',
      },
      {
        default: 20,
        description: 'Maximum files to include',
        max: 500,
        min: 1,
        name: 'maxFiles',
        required: false,
        type: 'number',
      },
      {
        default: 12_000,
        description: 'Maximum characters to return per file before truncation',
        max: 50_000,
        min: 1,
        name: 'maxCharsPerFile',
        required: false,
        type: 'number',
      },
      {
        default: true,
        description:
          'Apply selected Tapestry line ranges from the curated workspace context when available',
        name: 'useTapestrySelections',
        required: false,
        type: 'boolean',
      },
    ],
    returns:
      'Included file contents plus explicit skipped-file, truncation, and approximate token metadata',
    toolId: 'brainstrike.readWorkspaceContext',
  },

  'brainstrike.readWorkspaceDirectory': {
    description:
      'List workspace directory entries in a compact format with bounded depth and entry limits.',
    parameters: [
      {
        description: 'Directory path to list (defaults to workspace root)',
        name: 'path',
        required: false,
        type: 'string',
      },
      {
        description: 'Folder name or id to list when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        default: 1,
        description: 'Maximum directory depth to traverse',
        max: 5,
        min: 0,
        name: 'depth',
        required: false,
        type: 'number',
      },
      {
        default: 150,
        description: 'Maximum entries to return',
        max: 500,
        min: 1,
        name: 'maxEntries',
        required: false,
        type: 'number',
      },
      {
        default: true,
        description: 'Include file entries',
        name: 'includeFiles',
        required: false,
        type: 'boolean',
      },
      {
        default: true,
        description: 'Include directory entries',
        name: 'includeDirectories',
        required: false,
        type: 'boolean',
      },
      {
        default: false,
        description: 'Include hidden files and directories',
        name: 'includeHidden',
        required: false,
        type: 'boolean',
      },
      {
        default: false,
        description: 'Include per-entry size and depth metadata (default: path + type only)',
        name: 'detail',
        required: false,
        type: 'boolean',
      },
      {
        default: 0,
        description: 'Skip this many entries to continue a truncated listing',
        max: 5000,
        min: 0,
        name: 'offset',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'Compact entries (self-bounded to the tool output budget) with totals, truncation flag, and a continuation hint',
    toolId: 'brainstrike.readWorkspaceDirectory',
  },

  'brainstrike.readWorkspaceFile': {
    description:
      'Read a workspace file as bounded, line-numbered pages. Pass `nextCursor` back as `cursor` to continue without losing source text. Pass `root` on the first page to choose the folder when multiple are open; the cursor binds later pages to that root.',
    parameters: [
      {
        description: 'Workspace-relative file path; required only for the first page',
        minLength: 1,
        name: 'path',
        required: false,
        type: 'string',
      },
      {
        description:
          'Folder name or id to read from when multiple folders are open; omit on continuation to reuse the cursor-bound root',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        description:
          'Short thread-scoped handle returned as nextCursor; pass it unchanged with optional maxChars and omit every other field',
        name: 'cursor',
        required: false,
        type: 'string',
      },
      {
        description:
          '1-based starting line (inclusive); omit on continuation unless replaying the original value unchanged',
        min: 1,
        name: 'startLine',
        required: false,
        type: 'number',
      },
      {
        description:
          '1-based ending line (inclusive); omit on continuation unless replaying the original value unchanged',
        min: 1,
        name: 'endLine',
        required: false,
        type: 'number',
      },
      {
        default: 12_000,
        description: 'Maximum characters to return before truncating',
        max: 50_000,
        min: 200,
        name: 'maxChars',
        required: false,
        type: 'number',
      },
    ],
    returns:
      'Line-numbered file page with exact source metadata, truncation status, and nextCursor (null when complete)',
    toolId: 'brainstrike.readWorkspaceFile',
  },

  'brainstrike.renameWorkspaceFile': {
    description:
      'Rename or move a single file within the selected workspace root. FILES ONLY. The destination must NOT already exist (no overwrite — delete the target first if needed). Both paths stay inside ONE open folder (cross-root moves are refused); missing destination parent directories are created. Prefer this over a shell "mv" so the workspace index stays coherent. Requires approval (edit-risk).',
    parameters: [
      {
        description: 'Existing workspace-relative file path to rename/move from',
        minLength: 1,
        name: 'fromPath',
        required: true,
        type: 'string',
      },
      {
        description:
          'Destination workspace-relative file path (must not already exist; parent directories are created)',
        minLength: 1,
        name: 'toPath',
        required: true,
        type: 'string',
      },
      {
        description:
          'Folder name or id to operate in when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Rename result: ok: true, the normalized fromPath and toPath, rootName, and indexInvalidated (true when the source path had workspace-index rows that were removed; the destination is re-indexed by the background sync)',
    toolId: 'brainstrike.renameWorkspaceFile',
  },

  'brainstrike.stringReplaceWorkspaceFile': {
    description:
      'Surgically edit an existing workspace file: find one oldStr block and replace it with newStr. Matching is fuzzy (exact, then whitespace-tolerant, then close-match) but a single line that matches multiple locations, or no sufficiently close match, is REFUSED rather than guessed. Use an empty newStr to delete the block. Workspace-scoped and edit-risk (requires approval).',
    parameters: [
      {
        description: 'Workspace-relative file path to edit (the file must already exist)',
        minLength: 1,
        name: 'path',
        required: true,
        type: 'string',
      },
      {
        description:
          'Exact existing block to replace, with enough surrounding context to identify ONE location',
        maxLength: 8_000_000,
        minLength: 1,
        name: 'oldStr',
        required: true,
        type: 'string',
      },
      {
        description: 'Replacement text (empty string deletes the matched block)',
        maxLength: 8_000_000,
        name: 'newStr',
        required: true,
        type: 'string',
      },
      {
        description: 'Folder name or id to edit in when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Edit result: the normalized workspace path, bytesWritten, matchType (which cascade branch matched), and replaced: true',
    toolId: 'brainstrike.stringReplaceWorkspaceFile',
  },

  'brainstrike.updateWorkspaceContextSelection': {
    description:
      'Bulk update files selected in the workspace context explorer. Use this when curating reusable context for a prompt.',
    parameters: [
      {
        arrayItemType: 'string',
        description: 'Workspace-relative file paths to select',
        minLength: 1,
        name: 'filePaths',
        required: true,
        type: 'array',
      },
      {
        default: 'add',
        description: 'Selection update strategy',
        enumValues: ['replace', 'add', 'remove'],
        name: 'mode',
        required: false,
        type: 'enum',
      },
      {
        description: 'Optional folder id for multi-root workspaces',
        name: 'folderId',
        required: false,
        type: 'string',
      },
      {
        description:
          'Folder name or id to curate when multiple folders are open (omit when one). The selection applies to that folder even if it is not the focused one.',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns: 'Selection update result with applied and skipped paths',
    toolId: 'brainstrike.updateWorkspaceContextSelection',
  },

  'brainstrike.updateWorkspaceTapestrySelections': {
    description:
      'Create, update, or clear Tapestry line ranges for curated workspace context files. Ranges are 1-based and inclusive.',
    parameters: [
      {
        arrayItemType: 'object',
        description:
          'Per-file range updates: each item has path and ranges with startLine/endLine/isActive',
        minLength: 1,
        name: 'updates',
        required: true,
        type: 'array',
      },
      {
        default: 'replace',
        description: 'Range update strategy per file',
        enumValues: ['replace', 'add', 'clear'],
        name: 'mode',
        required: false,
        type: 'enum',
      },
      {
        description: 'Optional folder id for multi-root workspaces',
        name: 'folderId',
        required: false,
        type: 'string',
      },
      {
        description:
          'Open-folder name/id. Omit for the Focused folder; an explicit root always wins.',
        name: 'root',
        required: false,
        type: 'string',
      },
      {
        default: true,
        description: 'Also add affected files to the workspace context selection',
        name: 'selectFiles',
        required: false,
        type: 'boolean',
      },
    ],
    returns: 'Tapestry update result with applied and skipped file metadata',
    toolId: 'brainstrike.updateWorkspaceTapestrySelections',
  },

  'brainstrike.writeWorkspaceFile': {
    description:
      'Write or create a file in the selected workspace root. Overwrites any existing content and creates missing parent directories. Workspace-scoped: the path can never escape the open folder. Requires approval (edit-risk).',
    parameters: [
      {
        description: 'Workspace-relative file path to write (parent directories are created)',
        minLength: 1,
        name: 'path',
        required: true,
        type: 'string',
      },
      {
        description: 'Full UTF-8 file content to write, up to ~2 MB (overwrites any existing file)',
        maxLength: 8_000_000,
        name: 'content',
        required: true,
        type: 'string',
      },
      {
        description: 'Folder name or id to write to when multiple folders are open (omit when one)',
        name: 'root',
        required: false,
        type: 'string',
      },
    ],
    returns:
      'Write result: the normalized workspace path, bytesWritten, and created (true when a new file was created, false when an existing file was overwritten)',
    toolId: 'brainstrike.writeWorkspaceFile',
  },
} satisfies Partial<Record<NativeToolId, ToolSchemaDisplay>>;
