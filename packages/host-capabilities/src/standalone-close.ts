/**
 * The standalone platform's close, in order: the commands its runs left live
 * are retired first, then MCP (whose cleanup can still write OAuth records
 * through the credential store) and the host capabilities. A failed command
 * retirement never leaves MCP or the host open, and every failure is reported.
 */
export async function closeStandaloneOwners(owners: {
  readonly commands: () => Promise<unknown>;
  readonly host: { close(): Promise<void> };
  readonly mcp?: { close(): Promise<unknown> } | undefined;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    await owners.commands();
  } catch (cause) {
    failures.push(cause);
  }
  try {
    await owners.mcp?.close();
    await owners.host.close();
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Standalone platform close failed');
  }
}
