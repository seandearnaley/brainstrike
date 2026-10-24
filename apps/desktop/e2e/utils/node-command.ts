/**
 * A shell command that runs the same JavaScript wherever the app runs agent
 * commands: POSIX `sh -c` and Windows `cmd.exe /d /s /c` both pass one
 * double-quoted argument to `node` unchanged, as long as it holds none of the
 * characters either shell still interprets inside double quotes. Specs ask for
 * this instead of POSIX-only commands (`sleep`, `printf`, `test`, `>&2`).
 */
export function nodeCommand(script: string): string {
  const special = /["$`\\%!\r\n]/u.exec(script);
  if (special) {
    throw new Error(`nodeCommand scripts cannot contain ${JSON.stringify(special[0])}: ${script}`);
  }
  return `node -e "${script}"`;
}
