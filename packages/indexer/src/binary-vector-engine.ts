import { Schema } from 'effect';
import { decoder } from './contracts.js';
import type { CoarseVectorEngine } from './vector-engine.js';

/**
 * The coarse vector engine for a connection that cannot load sqlite-vec: the
 * browser's official sqlite-wasm build (BST-1940; the ticket's "binary codes
 * in JS plus rescoring from SQLite"). Code tables are ordinary tables; the
 * nearest codes are found by a Hamming scan of one partition in JavaScript.
 *
 * It registers sqlite-vec's scalar functions the derived store uses, computed
 * as sqlite-vec's portable build computes them (in-order float32 accumulation,
 * least-significant-bit first sign codes), so the shared SQL runs unchanged:
 * `vec_quantize_binary`, `vec_distance_cosine`, `vec_distance_l2` and
 * `vec_length`. sqlite-vec's macOS builds sum L2 in SIMD lanes, so there L2
 * agrees to within float32 summation error rather than bit for bit. Only
 * float32 blobs are accepted; sqlite-vec's JSON-text vector form is not used
 * by the derived store and is refused here.
 */
export const BINARY_VECTOR_ENGINE_VERSION = 'brainstrike-binary-codes-1';

const integer = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const decodeCodes = decoder(Schema.Array(Schema.Struct({ bin: Schema.Uint8Array, id: integer })));
const f32 = Math.fround;

const POPCOUNT = Uint8Array.from({ length: 256 }, (_, byte) => {
  let bits = 0;
  for (let value = byte; value !== 0; value >>= 1) {
    bits += value & 1;
  }
  return bits;
});

/** A float32 vector from its blob; copied, since a SQLite blob need not be 4-byte aligned. */
function floats(name: string, value: unknown): Float32Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name}: expected a float32 vector blob`);
  }
  if (value.byteLength === 0 || value.byteLength % 4 !== 0) {
    throw new TypeError(`${name}: a float32 vector blob's length must be a positive multiple of 4`);
  }
  return new Float32Array(Uint8Array.from(value).buffer);
}

function pair(name: string, a: unknown, b: unknown): [Float32Array, Float32Array] {
  const left = floats(name, a);
  const right = floats(name, b);
  if (left.length !== right.length) {
    throw new TypeError(`${name}: vector dimensions differ (${left.length} and ${right.length})`);
  }
  return [left, right];
}

/** sqlite-vec's `vec_quantize_binary`: bit i of the code is set when component i is positive. */
export function quantizeBinary(value: unknown): Uint8Array {
  const vector = floats('vec_quantize_binary', value);
  if (vector.length % 8 !== 0) {
    throw new TypeError('vec_quantize_binary: binary quantization needs dimensions divisible by 8');
  }
  const code = new Uint8Array(vector.length / 8);
  for (let index = 0; index < vector.length; index++) {
    if ((vector[index] as number) > 0) {
      code[index >> 3] = (code[index >> 3] as number) | (1 << (index & 7));
    }
  }
  return code;
}

/** sqlite-vec's `vec_distance_cosine` over float32 vectors. */
export function distanceCosine(a: unknown, b: unknown): number {
  const [left, right] = pair('vec_distance_cosine', a, b);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const x = left[index] as number;
    const y = right[index] as number;
    dot = f32(dot + f32(x * y));
    leftMagnitude = f32(leftMagnitude + f32(x * x));
    rightMagnitude = f32(rightMagnitude + f32(y * y));
  }
  return f32(1 - dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)));
}

/** sqlite-vec's `vec_distance_l2` over float32 vectors. */
export function distanceL2(a: unknown, b: unknown): number {
  const [left, right] = pair('vec_distance_l2', a, b);
  let sum = 0;
  for (let index = 0; index < left.length; index++) {
    const difference = f32((left[index] as number) - (right[index] as number));
    sum = f32(sum + f32(difference * difference));
  }
  return f32(Math.sqrt(sum));
}

function hamming(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length) {
    throw new TypeError(`binary codes differ in length (${left.length} and ${right.length})`);
  }
  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    distance += POPCOUNT[((left[index] as number) ^ (right[index] as number)) & 0xff] as number;
  }
  return distance;
}

export const binaryVectorEngine: CoarseVectorEngine = {
  attach(db) {
    const options = { deterministic: true };
    db.function('vec_quantize_binary', options, (value: unknown) => quantizeBinary(value));
    db.function('vec_distance_cosine', options, (a: unknown, b: unknown) => distanceCosine(a, b));
    db.function('vec_distance_l2', options, (a: unknown, b: unknown) => distanceL2(a, b));
    db.function('vec_length', options, (value: unknown) => floats('vec_length', value).length);
    return BINARY_VECTOR_ENGINE_VERSION;
  },
  candidates(db, table, query, columns) {
    const k = decoder(integer)(query.k);
    const code = quantizeBinary(query.vector);
    const among = query.among ? ` AND id IN (${query.among.sql})` : '';
    const nearest = decodeCodes(
      db
        .prepare(`SELECT id,bin FROM ${table} WHERE ${query.partitionColumn}=?${among}`)
        .all(query.partition, ...(query.among?.params ?? []))
    )
      .map((row) => ({ distance: hamming(row.bin, code), id: row.id }))
      // Among codes tied at the k-th distance the choice is engine-specific: sqlite-vec's follows its storage
      // layout (earlier chunks first, then the higher slot). The highest id agrees with it for rows stored in id
      // order within one storage chunk; elsewhere the engines may admit different, equally distant codes.
      .sort((a, b) => a.distance - b.distance || b.id - a.id)
      .slice(0, k)
      .map((row) => row.id);
    return {
      params: [JSON.stringify(nearest)],
      sql: `SELECT ${columns.join(',')} FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`,
    };
  },
  tableDefinition(table, spec) {
    const exists = spec.ifNotExists ? 'IF NOT EXISTS ' : '';
    const auxiliary = spec.auxiliary ? `,${spec.auxiliary} BLOB` : '';
    return `CREATE TABLE ${exists}${table}(id INTEGER PRIMARY KEY,${spec.partition} TEXT NOT NULL,bin BLOB NOT NULL${auxiliary});CREATE INDEX ${exists}${table}_partition ON ${table}(${spec.partition});`;
  },
};
