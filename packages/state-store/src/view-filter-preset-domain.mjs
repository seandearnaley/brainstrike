// @ts-check
import { DEFAULT_VIEW_FILTER_PRESETS } from '@brainstrike/types';

export const VIEW_FILTER_PRESET_SCHEMA = `
CREATE TABLE view_filter_presets (
  id TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK(json_valid(value)),
  sort_order INTEGER NOT NULL,
  is_default INTEGER NOT NULL CHECK(is_default IN (0,1))
) STRICT;
`;
/** @param {import('better-sqlite3').Database} db */
export function seedViewFilterPresets(db) {
  const now = new Date().toISOString();
  const write = db.prepare(
    'INSERT INTO view_filter_presets(id,value,sort_order,is_default) VALUES (?,?,?,1)'
  );
  for (const defaults of DEFAULT_VIEW_FILTER_PRESETS) {
    const preset = { ...defaults, createdAt: now, id: crypto.randomUUID(), updatedAt: now };
    write.run(preset.id, JSON.stringify(preset), preset.sortOrder);
  }
}
/** @param {import('better-sqlite3').Database} db @param {string} id @returns {import('@brainstrike/types').ViewFilterPresetRecord | undefined} */
function read(db, id) {
  const row = /** @type {{value:string}|undefined} */ (
    db.prepare('SELECT value FROM view_filter_presets WHERE id=?').get(id)
  );
  return row ? JSON.parse(row.value) : undefined;
}
/** @param {import('better-sqlite3').Database} db
 * @param {import('@brainstrike/types').ViewFilterPresetRequest} request
 * @returns {import('@brainstrike/types').ViewFilterPresetReply} */
export function executeViewFilterPresetRequest(db, request) {
  return db.transaction(
    /** @returns {import('@brainstrike/types').ViewFilterPresetReply} */ () => {
      if (request.operation === 'list') {
        const rows = /** @type {{value:string}[]} */ (
          db.prepare('SELECT value FROM view_filter_presets ORDER BY sort_order').all()
        );
        return { presets: rows.map((row) => JSON.parse(row.value)) };
      }
      if (request.operation === 'delete') {
        return {
          deleted:
            db
              .prepare('DELETE FROM view_filter_presets WHERE id=? AND is_default=0')
              .run(request.id).changes > 0,
          presets: [],
        };
      }
      const now = new Date().toISOString();
      if (request.operation === 'create') {
        const maximum = /** @type {{value:number}} */ (
          db.prepare('SELECT COALESCE(MAX(sort_order),0) AS value FROM view_filter_presets').get()
        );
        const preset = {
          ...request.input,
          createdAt: now,
          description: request.input.description ?? null,
          icon: request.input.icon ?? 'file',
          id: crypto.randomUUID(),
          isDefault: false,
          sortOrder: maximum.value + 1,
          updatedAt: now,
          useRegex: request.input.useRegex ?? false,
        };
        db.prepare(
          'INSERT INTO view_filter_presets(id,value,sort_order,is_default) VALUES (?,?,?,0)'
        ).run(preset.id, JSON.stringify(preset), preset.sortOrder);
        return { presets: [preset] };
      }
      const existing = read(db, request.id);
      if (!existing) {
        return { presets: [] };
      }
      if (request.input.sortOrder !== undefined && !Number.isSafeInteger(request.input.sortOrder)) {
        throw new Error('Preset order must be an integer');
      }
      const preset = { ...existing, ...request.input, updatedAt: now };
      db.prepare('UPDATE view_filter_presets SET value=?,sort_order=? WHERE id=?').run(
        JSON.stringify(preset),
        preset.sortOrder,
        preset.id
      );
      return { presets: [preset] };
    }
  )();
}
