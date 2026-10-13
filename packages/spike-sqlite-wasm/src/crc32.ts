// CRC-32 (IEEE 802.3, reflected 0xEDB88320), the same function as node:zlib crc32, which the
// desktop run log uses for every run_events row (packages/state-store/src/run-log-format.mjs).
// The browser has no built-in crc32, so web needs this to write rows desktop readers verify.
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
  }
  TABLE[n] = c >>> 0;
}

const encoder = new TextEncoder();

export function crc32(text: string): number {
  const bytes = encoder.encode(text);
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc = (TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}
