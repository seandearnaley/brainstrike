/**
 * Sends this fixture process's one result to its test owner over the IPC
 * channel, then closes the channel so the process can exit.
 *
 * The result never travels on stdout: @brainstrike/logging writes there from
 * pino's transport worker thread, on its own schedule (BST-2146).
 */
export async function sendFixtureResult(result) {
  if (!process.send) {
    throw new Error('This fixture reports over IPC; start it with child_process.fork.');
  }
  const send = process.send.bind(process);
  await new Promise((resolve, reject) => {
    send(result, (error) => (error ? reject(error) : resolve()));
  });
  process.disconnect();
}
