/**
 * ADR-0036: what a waiting file call would change, for its approval card. A
 * preview runs its tool's own checks, folder and path resolution, ignore rules
 * and matcher, then reads the file. It never writes, takes no lock or lease,
 * records no staleness observation and leaves the edit-failure streak alone.
 * A call it cannot show as text is a typed refusal, never an empty diff.
 */
import fsPromises from 'node:fs/promises';
import {
  applyStringReplace,
  NATIVE_TOOL_INPUT_SCHEMAS,
  type RuntimeData,
  StringReplaceError,
} from '@brainstrike/agent';
import {
  type ApprovalFileChange,
  type BoundaryFailureError,
  NATIVE_TOOL_ID,
  refusalError,
} from '@brainstrike/assistant-contract';
import type { EffectToolInputSchema } from '@brainstrike/assistant-contract/native-tool-schemas';
import {
  editedContentBytes,
  inspectDeleteLeaf,
  prepareDeleteWorkspaceFile,
  prepareStringReplaceWorkspaceFile,
  prepareWriteWorkspaceFile,
  readStringReplaceTarget,
} from './file-mutation-tools.ts';
import { inspectWriteLeaf } from './secure-file-write.ts';
import { WorkspacePathRefusal } from './workspace-path-resolution.ts';
import { readWorkspaceTextFile } from './workspace-text-file-reader.ts';

/** A waiting call's input, over the folders its execute would resolve now. */
export type FileChangePreview = (
  input: unknown,
  runtimeData: RuntimeData
) => Promise<ApprovalFileChange>;

/** A boundary refusal's message is at most 1000 characters. */
function previewRefusal(code: string, message: string): BoundaryFailureError {
  return refusalError('input', code, message.slice(0, 1000));
}

/** The call's input, through the validator its execute parses it with. */
async function callInput<Output>(
  schema: EffectToolInputSchema<Output>,
  input: unknown
): Promise<Output> {
  const result = await schema['~standard'].validate(input);
  if ('issues' in result) {
    throw previewRefusal('tool.input-invalid', 'The call’s arguments do not match its tool.');
  }
  return result.value;
}

/** A file that exists but is not text (binary, past the read cap, not a file) has no text diff. */
async function asText<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (
      error instanceof WorkspacePathRefusal &&
      (error.reason === 'binary' || error.reason === 'too-large' || error.reason === 'not-file')
    ) {
      throw previewRefusal('approval.preview-not-text', error.message);
    }
    throw error;
  }
}

async function previewWrite(input: unknown, runtimeData: RuntimeData): Promise<ApprovalFileChange> {
  const call = await callInput(NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.writeWorkspaceFile], input);
  const { resolved, root } = await prepareWriteWorkspaceFile(call, runtimeData);
  const { created } = await inspectWriteLeaf(resolved.absolutePath, call.path);
  const before = created
    ? null
    : (await asText(readWorkspaceTextFile({ requestedPath: call.path, rootPath: root.path })))
        .content;
  return { after: call.content, before, path: resolved.workspacePath };
}

async function previewStringReplace(
  input: unknown,
  runtimeData: RuntimeData
): Promise<ApprovalFileChange> {
  const call = await callInput(
    NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.stringReplaceWorkspaceFile],
    input
  );
  const { resolved, root } = await prepareStringReplaceWorkspaceFile(call, runtimeData);
  const file = await asText(readStringReplaceTarget(call.path, root.path));
  let after: string;
  try {
    // The pure matcher: a preview's miss is no failed edit, so the streak stays.
    after = applyStringReplace({
      fileContent: file.content,
      newStr: call.newStr,
      oldStr: call.oldStr,
    }).newContent;
  } catch (error) {
    if (error instanceof StringReplaceError) {
      throw previewRefusal('approval.preview-edit-refused', error.message);
    }
    throw error;
  }
  editedContentBytes(call.path, after);
  return { after, before: file.content, path: resolved.workspacePath };
}

async function previewDelete(
  input: unknown,
  runtimeData: RuntimeData
): Promise<ApprovalFileChange> {
  const call = await callInput(
    NATIVE_TOOL_INPUT_SCHEMAS[NATIVE_TOOL_ID.deleteWorkspaceFile],
    input
  );
  const { mutationPath, resolved, root } = await prepareDeleteWorkspaceFile(call, runtimeData);
  const leaf = await inspectDeleteLeaf(mutationPath, call.path);
  // A delete removes a symlink itself and leaves its target. Git stores a link
  // as the path it points to, so that path is the text the call removes.
  const before = leaf.isSymbolicLink()
    ? await fsPromises.readlink(mutationPath, 'utf8')
    : (await asText(readWorkspaceTextFile({ requestedPath: call.path, rootPath: root.path })))
        .content;
  return { after: null, before, path: resolved.workspacePath };
}

/** The file tools whose approval shows the change their call would make, by catalog id. */
export const FILE_CHANGE_PREVIEWS: Readonly<Record<string, FileChangePreview>> = {
  [NATIVE_TOOL_ID.deleteWorkspaceFile]: previewDelete,
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]: previewStringReplace,
  [NATIVE_TOOL_ID.writeWorkspaceFile]: previewWrite,
};
