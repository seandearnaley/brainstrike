// BST-2246: first, before this process creates anything, so everything it
// creates is owned by the user even when an elevated token defaults to
// BUILTIN\Administrators.
import '@brainstrike/secure-fs-native/default-owner';

// The forked agent host's entry. The host runs without Node's on-disk compile cache
// (BST-2239): every Node instance persists what it compiled when it exits, and cold on
// hosted Windows that persist took 3.5 s on the host thread and 1.6 s and 4 s in the
// state index's worker and nested writer, inside the close deadlines their owners join.
const { runAgentHostProcess } = await import('./process-entry.ts');
try {
  await runAgentHostProcess(process.argv.slice(2));
} catch (cause) {
  process.exitCode = 1;
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
}
