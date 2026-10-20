import { prepareRendererClose } from '@brainstrike/app-state/renderer-close';
import { createDocumentCloseProof } from '../document-close-proof';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';

/** Main asks before DOM unload can dispose the frame's host transport. */
export function installDesktopRendererClose(
  connection: DesktopHostConnection = windowHostConnection()
): void {
  const bridge = window.agentHost;
  if (!bridge) {
    throw new Error('The desktop host lifecycle capability is unavailable');
  }
  const observing = window.brainstrikeWorkspacePhaseTrace === true;
  const proof = createDocumentCloseProof(observing, 'renderer');
  bridge.onPrepareClose(async () => {
    // The document is terminal. Native inert fences new pointer/keyboard work
    // while already-admitted producers and persistence keep their ACK channel.
    document.body.inert = true;
    proof('renderer-prepare-begin');
    try {
      await prepareRendererClose(
        observing ? (phase, settlement) => proof(`renderer-${phase}-${settlement}`) : undefined
      );
      proof('renderer-prepare-end');
    } catch (cause) {
      proof('renderer-prepare-failure');
      throw cause;
    }
    proof('host-connection-close-begin');
    try {
      await connection.close();
      proof('host-connection-close-end');
    } catch (cause) {
      proof('host-connection-close-failure');
      throw cause;
    }
  });
}
