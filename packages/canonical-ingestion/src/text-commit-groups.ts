/**
 * A commit's message carries every file's whole payload: its content, chunks and syntax records.
 * Symbol-dense source can serialize to several times its text, so a group is bounded by each
 * file's serialized UTF-8 size, the measure the utility port applies to its 32 MiB frames, with
 * room left for the request envelope.
 */
const COMMIT_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** A batch's text files in order, grouped so each group's payloads stay within one commit. */
export function textCommitGroups<File extends { readonly payload: unknown }>(
  files: readonly File[]
): File[][] {
  const groups: File[][] = [];
  let group: File[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(JSON.stringify(file.payload), 'utf8');
    if (group.length > 0 && bytes + size > COMMIT_PAYLOAD_BYTES) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(file);
    bytes += size;
  }
  if (group.length > 0) {
    groups.push(group);
  }
  return groups;
}
