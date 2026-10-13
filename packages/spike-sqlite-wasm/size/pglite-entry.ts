// Engine-only size probe: today's web DB worker engine (production factory, full extension set).
import { createEnginePglite } from '../../db/src/pglite-factory';

const db = await createEnginePglite({ dataDir: 'idb://size-probe' });
postMessage((await db.query('SELECT version()')).rows);
