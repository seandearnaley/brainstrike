import type { BrainstrikeDbTransactionClient } from '../architecture/brainstrike-db-client-contract.js';

export const TURSO_SCHEMA_LEDGER_TABLE = 'brainstrike_turso_schema_ledger';
export const TURSO_FORBIDDEN_MIGRATION_LEDGER_TABLES = ['_migrations', '__drizzle_migrations'];

export interface TursoSchemaLedgerEntry {
  readonly appliedAt: string;
  readonly checksum: string;
  readonly version: number;
}

export async function assertNoPostgresMigrationLedgers(
  client: BrainstrikeDbTransactionClient
): Promise<void> {
  const forbidden = await findForbiddenMigrationLedgerTables(client);
  if (forbidden.length > 0) {
    throw new Error(
      `Turso schema baseline cannot run with Postgres/PGlite migration ledgers present: ${forbidden.join(', ')}.`
    );
  }
}

export async function ensureTursoSchemaLedger(
  client: BrainstrikeDbTransactionClient
): Promise<void> {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS ${TURSO_SCHEMA_LEDGER_TABLE} (
      version INTEGER PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
}

export async function readTursoSchemaLedgerEntry(
  client: BrainstrikeDbTransactionClient,
  version: number
): Promise<TursoSchemaLedgerEntry | null> {
  const result = await client.query<{
    applied_at: string;
    checksum: string;
    version: number;
  }>(`SELECT version, checksum, applied_at FROM ${TURSO_SCHEMA_LEDGER_TABLE} WHERE version = ?`, [
    version,
  ]);
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    appliedAt: row.applied_at,
    checksum: row.checksum,
    version: row.version,
  };
}

export async function assertTursoSchemaLedgerHasNoUnknownVersions(
  client: BrainstrikeDbTransactionClient,
  knownVersions: readonly number[]
): Promise<void> {
  const result = await client.query<{ version: number }>(
    `SELECT version FROM ${TURSO_SCHEMA_LEDGER_TABLE} ORDER BY version`
  );
  const known = new Set(knownVersions);
  const unknown = result.rows.map((row) => row.version).filter((version) => !known.has(version));
  if (unknown.length > 0) {
    throw new Error(
      `Turso schema ledger contains unknown baseline versions: ${unknown.join(', ')}.`
    );
  }
}

export async function recordTursoSchemaLedgerEntry(
  client: BrainstrikeDbTransactionClient,
  entry: {
    readonly checksum: string;
    readonly version: number;
  }
): Promise<void> {
  await client.exec(`INSERT INTO ${TURSO_SCHEMA_LEDGER_TABLE} (version, checksum) VALUES (?, ?)`, [
    entry.version,
    entry.checksum,
  ]);
}

export type TursoSchemaChecksumPart =
  | string
  | {
      readonly params?: readonly unknown[];
      readonly sql: string;
    };

export function computeTursoSchemaChecksum(parts: readonly TursoSchemaChecksumPart[]): string {
  return sha256Hex(parts.map(serializeTursoSchemaChecksumPart).join('\n-- statement --\n'));
}

function serializeTursoSchemaChecksumPart(part: TursoSchemaChecksumPart): string {
  if (typeof part === 'string') {
    return JSON.stringify({ kind: 'sql', sql: part });
  }
  return JSON.stringify({ kind: 'statement', params: part.params ?? [], sql: part.sql });
}

const SHA256_INITIAL_HASH = [
  0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f, 0x9b_05_68_8c,
  0x1f_83_d9_ab, 0x5b_e0_cd_19,
] as const;

const SHA256_ROUND_CONSTANTS = [
  0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b, 0x59_f1_11_f1,
  0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01, 0x24_31_85_be, 0x55_0c_7d_c3,
  0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7, 0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86,
  0x0f_c1_9d_c6, 0x24_0c_a1_cc, 0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da,
  0x98_3e_51_52, 0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
  0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc, 0x53_38_0d_13,
  0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85, 0xa2_bf_e8_a1, 0xa8_1a_66_4b,
  0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19, 0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70,
  0x19_a4_c1_16, 0x1e_37_6c_08, 0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a,
  0x5b_9c_ca_4f, 0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
  0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
] as const;

function sha256Hex(input: string): string {
  const view = createSha256PaddedDataView(input);
  const hash: number[] = [...SHA256_INITIAL_HASH];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < view.byteLength; offset += 64) {
    loadSha256Words(view, words, offset);
    extendSha256Words(words);
    compressSha256Block(hash, words);
  }

  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function createSha256PaddedDataView(input: string): DataView {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_00_00_00_00), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  return view;
}

function loadSha256Words(view: DataView, words: Uint32Array, offset: number): void {
  for (let index = 0; index < 16; index += 1) {
    words[index] = view.getUint32(offset + index * 4, false);
  }
}

function extendSha256Words(words: Uint32Array): void {
  for (let index = 16; index < 64; index += 1) {
    const previous15 = words[index - 15] ?? 0;
    const previous2 = words[index - 2] ?? 0;
    const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
    const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
    words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
  }
}

function compressSha256Block(hash: number[], words: Uint32Array): void {
  let a = hash[0] ?? 0;
  let b = hash[1] ?? 0;
  let c = hash[2] ?? 0;
  let d = hash[3] ?? 0;
  let e = hash[4] ?? 0;
  let f = hash[5] ?? 0;
  let g = hash[6] ?? 0;
  let h = hash[7] ?? 0;

  for (let index = 0; index < 64; index += 1) {
    const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choice = (e & f) ^ (~e & g);
    const temporary1 =
      (h + sigma1 + choice + (SHA256_ROUND_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
    const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temporary2 = (sigma0 + majority) >>> 0;

    h = g;
    g = f;
    f = e;
    e = (d + temporary1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temporary1 + temporary2) >>> 0;
  }

  addSha256State(hash, [a, b, c, d, e, f, g, h]);
}

function addSha256State(hash: number[], next: readonly number[]): void {
  for (let index = 0; index < hash.length; index += 1) {
    hash[index] = ((hash[index] ?? 0) + (next[index] ?? 0)) >>> 0;
  }
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

async function findForbiddenMigrationLedgerTables(
  client: BrainstrikeDbTransactionClient
): Promise<readonly string[]> {
  const placeholders = TURSO_FORBIDDEN_MIGRATION_LEDGER_TABLES.map(() => '?').join(', ');
  const result = await client.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) ORDER BY name`,
    TURSO_FORBIDDEN_MIGRATION_LEDGER_TABLES
  );
  return result.rows.map((row) => row.name);
}
