// @ts-check
/** Mutable choices only. Model facts remain in the existing canonical provider catalog. */
export const MODEL_CHOICE_SCHEMA = `
CREATE TABLE provider_choices (
  provider_id TEXT PRIMARY KEY NOT NULL CHECK(length(provider_id)>0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
) STRICT;
CREATE TABLE model_choices (
  provider_id TEXT NOT NULL CHECK(length(provider_id)>0),
  model_id TEXT NOT NULL CHECK(length(model_id)>0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  PRIMARY KEY(provider_id,model_id)
) STRICT;
`;
/** @param {import('better-sqlite3').Database} db @returns {import('./model-choice-types.js').ModelChoiceSnapshot} */
function snapshot(db) {
  const models = /** @type {{providerId:string;modelId:string;enabled:0|1}[]} */ (
    db
      .prepare(
        'SELECT provider_id AS providerId,model_id AS modelId,enabled FROM model_choices ORDER BY provider_id,model_id'
      )
      .all()
  );
  const providers = /** @type {{providerId:string;enabled:0|1}[]} */ (
    db
      .prepare(
        'SELECT provider_id AS providerId,enabled FROM provider_choices ORDER BY provider_id'
      )
      .all()
  );
  return {
    models: models.map((row) => ({ ...row, enabled: row.enabled === 1 })),
    providers: providers.map((row) => ({ ...row, enabled: row.enabled === 1 })),
  };
}
/** @param {string} value */
function identity(value) {
  if (!value.trim()) {
    throw new Error('Catalog choice requires its original nonblank identity');
  }
}
/** @param {import('better-sqlite3').Database} db
 * @param {readonly import('./model-choice-types.js').ModelChoice[]} models */
function writeModels(db, models) {
  if (models.length === 0) {
    throw new Error('Model choice batch is empty');
  }
  const pairs = new Set();
  for (const model of models) {
    identity(model.providerId);
    identity(model.modelId);
    const pair = JSON.stringify([model.providerId, model.modelId]);
    if (pairs.has(pair)) {
      throw new Error('Model choice batch contains a duplicate identity');
    }
    pairs.add(pair);
  }
  const write = db.prepare(
    'INSERT INTO model_choices(provider_id,model_id,enabled) VALUES (?,?,?) ON CONFLICT(provider_id,model_id) DO UPDATE SET enabled=excluded.enabled'
  );
  for (const model of models) {
    write.run(model.providerId, model.modelId, Number(model.enabled));
  }
}
/** @param {import('better-sqlite3').Database} db
 * @param {import('./model-choice-types.js').ModelChoiceRequest & {operation:'initialize'}} request
 * @returns {'initialized'|'preserved'} */
function initializeModels(db, request) {
  identity(request.providerId);
  if (request.policy === 'seed' && request.modelIds.length === 0) {
    throw new Error('Recommended model defaults are empty');
  }
  for (const modelId of request.modelIds) {
    identity(modelId);
  }
  if (
    request.policy === 'seed' &&
    db.prepare('SELECT 1 FROM model_choices WHERE provider_id=? LIMIT 1').get(request.providerId)
  ) {
    return 'preserved';
  }
  let changed = 0;
  const write = db.prepare(
    'INSERT OR IGNORE INTO model_choices(provider_id,model_id,enabled) VALUES (?,?,1)'
  );
  for (const modelId of request.modelIds) {
    changed += write.run(request.providerId, modelId).changes;
  }
  return changed > 0 ? 'initialized' : 'preserved';
}
/** @param {import('better-sqlite3').Database} db
 * @param {import('./model-choice-types.js').ModelChoiceRequest} request
 * @returns {import('./model-choice-types.js').ModelChoiceResult} */
export function executeModelChoiceRequest(db, request) {
  return db.transaction(() => {
    const previous = snapshot(db);
    switch (request.operation) {
      case 'snapshot':
        return snapshot(db);
      case 'provider':
        identity(request.providerId);
        db.prepare(
          'INSERT INTO provider_choices(provider_id,enabled) VALUES (?,?) ON CONFLICT(provider_id) DO UPDATE SET enabled=excluded.enabled'
        ).run(request.providerId, Number(request.enabled));
        break;
      case 'models':
        writeModels(db, request.models);
        break;
      case 'initialize': {
        const outcome = initializeModels(db, request);
        return { ...snapshot(db), outcome, previous };
      }
      default:
        throw new Error('Unknown model choice operation');
    }
    return { ...snapshot(db), previous };
  })();
}
