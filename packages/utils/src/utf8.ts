/**
 * The UTF-8 byte length of `text`, as Node's `Buffer.byteLength(text, 'utf8')`
 * counts it, without encoding a copy: a lone surrogate counts as the three
 * bytes of the replacement character it encodes to. Runs wherever JavaScript
 * does, browser workers included.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x8_00) {
      bytes += 2;
    } else if (unit >= 0xd8_00 && unit <= 0xdb_ff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc_00 && next <= 0xdf_ff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
