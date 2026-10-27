// @ts-check
import { AGENT_SEMANTIC_COLOR_IDS, ASSISTANT_THREAD_ICON_IDS } from '@brainstrike/types';
export const THREAD_GROUPS_SCHEMA = `
CREATE TABLE thread_groups (id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, name TEXT NOT NULL, rank TEXT NOT NULL, color TEXT, icon TEXT) STRICT;
CREATE TABLE thread_placements (thread_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, group_id TEXT REFERENCES thread_groups(id) ON DELETE SET NULL, rank TEXT NOT NULL, flat_rank TEXT) STRICT;
CREATE INDEX thread_groups_resource ON thread_groups(resource_id,rank,id);
CREATE INDEX thread_placements_resource ON thread_placements(resource_id);
`;
/** Pins are their own rows: a placement write never touches a pin, nor a pin a placement. */
export const THREAD_PINS_SCHEMA = `
CREATE TABLE thread_pins (thread_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, pinned_at INTEGER NOT NULL CHECK (pinned_at >= 0)) STRICT;
CREATE INDEX thread_pins_resource ON thread_pins(resource_id);
`;
/** @type {import('@brainstrike/types').ThreadGroupsReply} */
const EMPTY_REPLY = Object.freeze({ groups: [], pins: [], placements: [] });
/** @param {string} value */
function required(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Thread group field is required');
  }
  return value;
}
/** @param {string|null} value @param {readonly string[]} values */
function choice(value, values) {
  if (value !== null && !values.includes(value)) {
    throw new Error('Invalid thread group presentation');
  }
  return value;
}
/** @param {import('better-sqlite3').Database} db @param {string} id */
function group(db, id) {
  const row = /** @type {{resourceId:string}|undefined} */ (
    db.prepare('SELECT resource_id AS resourceId FROM thread_groups WHERE id=?').get(required(id))
  );
  if (!row) {
    throw new Error('Thread group does not exist');
  }
  return row;
}
/** @param {import('better-sqlite3').Database} db @param {readonly import('@brainstrike/types').AssistantThreadPlacement[]} placements */
function writePlacements(db, placements) {
  const seen = new Set();
  for (const p of placements) {
    if (seen.has(p.threadId)) {
      throw new Error('Duplicate thread placement');
    }
    seen.add(p.threadId);
    if (p.groupId !== null && group(db, p.groupId).resourceId !== p.resourceId) {
      throw new Error('Thread group resource mismatch');
    }
    db.prepare(
      'INSERT INTO thread_placements VALUES (?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET resource_id=excluded.resource_id,group_id=excluded.group_id,rank=excluded.rank,flat_rank=excluded.flat_rank'
    ).run(
      required(p.threadId),
      required(p.resourceId),
      p.groupId,
      required(p.rank),
      p.flatRank === null ? null : required(p.flatRank)
    );
  }
}
/** @param {import('better-sqlite3').Database} db @param {readonly import('@brainstrike/types').AssistantThreadGroupRankEntry[]} entries */
function writeRanks(db, entries) {
  for (const entry of entries) {
    group(db, entry.groupId);
    db.prepare('UPDATE thread_groups SET rank=? WHERE id=?').run(
      required(entry.rank),
      entry.groupId
    );
  }
}
/** @param {import('better-sqlite3').Database} db @param {readonly string[]} ids */
function clearPlacements(db, ids) {
  if (new Set(ids).size !== ids.length) {
    throw new Error('Duplicate thread placement');
  }
  for (const id of ids) {
    db.prepare('DELETE FROM thread_placements WHERE thread_id=?').run(required(id));
    db.prepare('DELETE FROM thread_pins WHERE thread_id=?').run(id);
  }
}
/** @param {import('better-sqlite3').Database} db @param {string} resourceId @returns {import('@brainstrike/types').ThreadGroupsReply} */
function listThreadGroups(db, resourceId) {
  return {
    groups: /** @type {import('@brainstrike/types').AssistantThreadGroup[]} */ (
      db
        .prepare(
          'SELECT id,resource_id AS resourceId,name,rank,color,icon FROM thread_groups WHERE resource_id=? ORDER BY rank,id'
        )
        .all(required(resourceId))
    ),
    pins: /** @type {import('@brainstrike/types').AssistantThreadPin[]} */ (
      db
        .prepare(
          'SELECT thread_id AS threadId,resource_id AS resourceId,pinned_at AS pinnedAt FROM thread_pins WHERE resource_id=? ORDER BY pinned_at DESC,thread_id'
        )
        .all(resourceId)
    ),
    placements: /** @type {import('@brainstrike/types').AssistantThreadPlacement[]} */ (
      db
        .prepare(
          'SELECT thread_id AS threadId,resource_id AS resourceId,group_id AS groupId,rank,flat_rank AS flatRank FROM thread_placements WHERE resource_id=? ORDER BY thread_id'
        )
        .all(resourceId)
    ),
  };
}
/** @param {import('better-sqlite3').Database} db @param {import('@brainstrike/types').AssistantThreadPin} pin */
function writePin(db, pin) {
  if (!Number.isSafeInteger(pin.pinnedAt) || pin.pinnedAt < 0) {
    throw new Error('Thread pin time must be a nonnegative integer');
  }
  db.prepare(
    'INSERT INTO thread_pins VALUES (?,?,?) ON CONFLICT(thread_id) DO UPDATE SET resource_id=excluded.resource_id,pinned_at=excluded.pinned_at'
  ).run(required(pin.threadId), required(pin.resourceId), pin.pinnedAt);
}
/** @param {import('better-sqlite3').Database} db @param {Extract<import('@brainstrike/types').ThreadGroupsRequest, { groupId: string }>} request */
function writeGroup(db, request) {
  group(db, request.groupId);
  if (request.operation === 'delete') {
    db.prepare('DELETE FROM thread_groups WHERE id=?').run(request.groupId);
  }
  if (request.operation === 'rename') {
    db.prepare('UPDATE thread_groups SET name=? WHERE id=?').run(
      required(request.name).trim(),
      request.groupId
    );
  }
  if (request.operation === 'color') {
    db.prepare('UPDATE thread_groups SET color=? WHERE id=?').run(
      choice(request.color, AGENT_SEMANTIC_COLOR_IDS),
      request.groupId
    );
  }
  if (request.operation === 'icon') {
    db.prepare('UPDATE thread_groups SET icon=? WHERE id=?').run(
      choice(request.icon, ASSISTANT_THREAD_ICON_IDS),
      request.groupId
    );
  }
}
/** @param {import('better-sqlite3').Database} db @param {import('@brainstrike/types').ThreadGroupsRequest} request @returns {import('@brainstrike/types').ThreadGroupsReply} */
export function executeThreadGroups(db, request) {
  return db.transaction(
    /** @returns {import('@brainstrike/types').ThreadGroupsReply} */ () => {
      if (request.operation === 'list') {
        return listThreadGroups(db, request.resourceId);
      }
      if (request.operation === 'create') {
        const g = request.group;
        db.prepare('INSERT INTO thread_groups VALUES (?,?,?,?,?,?)').run(
          required(g.id),
          required(g.resourceId),
          required(g.name).trim(),
          required(g.rank),
          choice(g.color, AGENT_SEMANTIC_COLOR_IDS),
          choice(g.icon, ASSISTANT_THREAD_ICON_IDS)
        );
        return { ...EMPTY_REPLY, groups: [{ ...g, name: g.name.trim() }] };
      }
      if (request.operation === 'placements') {
        writePlacements(db, request.placements);
        return EMPTY_REPLY;
      }
      if (request.operation === 'pin') {
        writePin(db, request.pin);
        return EMPTY_REPLY;
      }
      if (request.operation === 'unpin') {
        db.prepare('DELETE FROM thread_pins WHERE thread_id=?').run(required(request.threadId));
        return EMPTY_REPLY;
      }
      if (request.operation === 'clear') {
        clearPlacements(db, request.threadIds);
        return EMPTY_REPLY;
      }
      if (request.operation === 'ranks') {
        writeRanks(db, request.entries);
        return EMPTY_REPLY;
      }
      writeGroup(db, request);
      return EMPTY_REPLY;
    }
  )();
}
