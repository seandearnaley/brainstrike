import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/client';
import type { McpLabAppliedFault, McpLabFaultRuntime } from './fault-runtime.js';
import type { McpLabProtocolEra } from './faults.js';
import {
  type McpLabStdioCoordinate,
  stdioProtocolCoordinate,
  stdioResponseId,
} from './stdio-coordinates.js';

function responseIdKey(id: RequestId): string {
  return `${typeof id}:${id}`;
}

export class McpLabStdioProtocolFaults {
  private closing = false;
  private readonly droppedResponseIds = new Set<string>();
  private readonly enabled: boolean;
  private readonly occurrences = new Map<string, number>();
  private readonly pendingDropResponseIds = new Set<string>();
  private readonly pendingResponseDeliveries = new Map<string, Array<() => void>>();
  private sendTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly runtime: McpLabFaultRuntime,
    private readonly era: McpLabProtocolEra
  ) {
    this.enabled = (['initialization', 'operation', 'subscription'] as const).some((phase) =>
      runtime.hasRemainingPhase(phase)
    );
  }

  send(message: JSONRPCMessage, delegateSend: () => Promise<void>): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error('MCP lab stdio protocol fault executor is closing'));
    }
    if (!this.enabled) {
      return delegateSend();
    }
    const sending = this.sendTail.then(() => this.sendOne(message, delegateSend));
    this.sendTail = sending.then(
      () => undefined,
      () => undefined
    );
    return sending;
  }

  receive(message: JSONRPCMessage, deliver: () => void): void {
    const id = stdioResponseId(message);
    if (id === undefined) {
      deliver();
      return;
    }
    const key = responseIdKey(id);
    if (this.pendingDropResponseIds.has(key)) {
      const deliveries = this.pendingResponseDeliveries.get(key) ?? [];
      deliveries.push(deliver);
      this.pendingResponseDeliveries.set(key, deliveries);
      return;
    }
    if (!this.droppedResponseIds.delete(key)) {
      deliver();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.sendTail;
  }

  finishClose(): void {
    this.droppedResponseIds.clear();
    this.pendingDropResponseIds.clear();
    this.pendingResponseDeliveries.clear();
  }

  private cancelPendingDrop(key: string | undefined): void {
    if (!key) {
      return;
    }
    this.pendingDropResponseIds.delete(key);
    // A failed send can release its typed-id response after unrelated inbound messages. The SDK
    // correlates responses by that id, and release is required because the fault never committed.
    this.releasePendingResponses(key);
  }

  private commitCoordinate(
    coordinate: McpLabStdioCoordinate,
    occurrenceKey: string,
    occurrence: number,
    pendingDropKey: string | undefined
  ): void {
    let applied: McpLabAppliedFault | undefined;
    try {
      this.occurrences.set(occurrenceKey, occurrence);
      const correlationId = this.runtime.reserveCorrelation(undefined, 'stdio-message');
      applied = this.runtime.consume(coordinate.phase, coordinate.method, correlationId);
    } catch (error) {
      this.cancelPendingDrop(pendingDropKey);
      throw error;
    }
    if (!applied) {
      this.cancelPendingDrop(pendingDropKey);
      return;
    }
    if (applied.fault.kind === 'delay') {
      return;
    }
    if (applied.fault.kind === 'drop_response' && pendingDropKey) {
      this.pendingDropResponseIds.delete(pendingDropKey);
      if (!this.suppressFirstPendingResponse(pendingDropKey)) {
        this.droppedResponseIds.add(pendingDropKey);
      }
      return;
    }
    this.cancelPendingDrop(pendingDropKey);
    throw new Error(`MCP lab fault "${applied.id}" is invalid during stdio send`);
  }

  private releasePendingResponses(key: string): void {
    const deliveries = this.pendingResponseDeliveries.get(key) ?? [];
    this.pendingResponseDeliveries.delete(key);
    for (const deliver of deliveries) {
      deliver();
    }
  }

  private async sendOne(message: JSONRPCMessage, delegateSend: () => Promise<void>): Promise<void> {
    const coordinate = await stdioProtocolCoordinate(message, this.era);
    if (!coordinate) {
      await delegateSend();
      return;
    }
    const occurrenceKey = `${coordinate.phase}\u0000${coordinate.method}`;
    const occurrence = (this.occurrences.get(occurrenceKey) ?? 0) + 1;
    const configured = this.runtime.configuredFault(
      coordinate.phase,
      coordinate.method,
      occurrence
    );
    if (configured?.kind === 'delay') {
      await new Promise<void>((resolve) => setTimeout(resolve, configured.delayMs));
    }
    const pendingDropKey =
      configured?.kind === 'drop_response' && coordinate.requestId !== undefined
        ? responseIdKey(coordinate.requestId)
        : undefined;
    if (pendingDropKey) {
      this.pendingDropResponseIds.add(pendingDropKey);
    }
    try {
      await delegateSend();
    } catch (error) {
      this.cancelPendingDrop(pendingDropKey);
      throw error;
    }
    this.commitCoordinate(coordinate, occurrenceKey, occurrence, pendingDropKey);
  }

  private suppressFirstPendingResponse(key: string): boolean {
    const deliveries = this.pendingResponseDeliveries.get(key);
    this.pendingResponseDeliveries.delete(key);
    if (!deliveries || deliveries.length === 0) {
      return false;
    }
    for (const deliver of deliveries.slice(1)) {
      deliver();
    }
    return true;
  }
}
