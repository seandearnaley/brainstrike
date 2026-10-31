/**
 * A text commit carries each file's content and its chunks, about twice the text, in one message.
 * Bounding a call's text (in UTF-16 code units, at most 3 UTF-8 bytes each) keeps that message well
 * under the utility port's frame limit when a batch holds large files.
 */
const TEXT_COMMIT_CHARS = 4 * 1024 * 1024;

/** A batch's text files in order, grouped so each group's text stays within one commit. */
export function textCommitGroups<File extends { readonly payload: { readonly content: string } }>(
  files: readonly File[]
): File[][] {
  const groups: File[][] = [];
  let group: File[] = [];
  let chars = 0;
  for (const file of files) {
    const size = file.payload.content.length;
    if (group.length > 0 && chars + size > TEXT_COMMIT_CHARS) {
      groups.push(group);
      group = [];
      chars = 0;
    }
    group.push(file);
    chars += size;
  }
  if (group.length > 0) {
    groups.push(group);
  }
  return groups;
}
