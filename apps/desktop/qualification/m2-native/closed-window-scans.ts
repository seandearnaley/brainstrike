import type { CanonicalScanReceipt } from '../../../../packages/canonical-ingestion/src/ports';

export interface SettledScan {
  readonly receipt: CanonicalScanReceipt;
  readonly settledAt: string;
}

export function settledScans(output: readonly string[]): SettledScan[] {
  const settled: SettledScan[] = [];
  for (const line of output.join('\n').split('\n')) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Reflect.get(value, 'msg') !== 'Canonical native scan settled'
    ) {
      continue;
    }
    const receipt: unknown = Reflect.get(value, 'receipt');
    const settledAt: unknown = Reflect.get(value, 'settledAt');
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      typeof settledAt !== 'string' ||
      !Number.isFinite(Date.parse(settledAt))
    ) {
      throw new Error('Malformed actual canonical scan log.');
    }
    const ticket: unknown = Reflect.get(receipt, 'ticket');
    if (
      !ticket ||
      typeof ticket !== 'object' ||
      typeof Reflect.get(ticket, 'requestId') !== 'string' ||
      typeof Reflect.get(ticket, 'storeId') !== 'string' ||
      !Number.isSafeInteger(Reflect.get(ticket, 'generation'))
    ) {
      throw new Error('Canonical settled receipt has no valid physical ticket.');
    }
    settled.push({ receipt: receipt as unknown as CanonicalScanReceipt, settledAt });
  }
  return settled;
}
