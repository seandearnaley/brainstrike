import { prepareRendererClose } from '@brainstrike/app-state/renderer-close';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';

/** Main asks before DOM unload can dispose the frame's host transport. */
export function installDesktopRendererClose(
  connection: DesktopHostConnection = windowHostConnection()
): void {
  const bridge = window.agentHost;
  if (!bridge) {
    throw new Error('The desktop host lifecycle capability is unavailable');
  }
  bridge.onPrepareClose(async () => {
    // The document is terminal. Native inert fences new pointer/keyboard work
    // while already-admitted producers and persistence keep their ACK channel.
    document.body.inert = true;
    await prepareRendererClose();
    await connection.close();
  });
}
