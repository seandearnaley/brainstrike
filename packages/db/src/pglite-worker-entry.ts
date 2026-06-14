import type { PGliteOptions } from '@electric-sql/pglite';

type BrainstrikePGliteWorkerInitOptions = Pick<PGliteOptions, 'dataDir' | 'relaxedDurability'>;

interface BrowserWorkerProcess {
  env: Record<string, string | undefined>;
}

interface BrowserWorkerGlobal {
  process?: BrowserWorkerProcess;
}

interface ViteImportMetaEnv {
  MODE?: string;
}

interface ViteImportMeta extends ImportMeta {
  env?: ViteImportMetaEnv;
}

function resolveWorkerNodeEnv(): string {
  const mode = (import.meta as ViteImportMeta).env?.MODE;
  if (typeof mode !== 'string' || mode.length === 0) {
    throw new Error('PGlite worker requires import.meta.env.MODE');
  }
  return mode;
}

function ensureBrowserWorkerProcessEnv(): void {
  const workerGlobal = globalThis as unknown as BrowserWorkerGlobal;
  const nodeEnv = resolveWorkerNodeEnv();

  if (!workerGlobal.process) {
    workerGlobal.process = { env: { NODE_ENV: nodeEnv } };
    return;
  }

  if (!workerGlobal.process.env) {
    workerGlobal.process.env = { NODE_ENV: nodeEnv };
    return;
  }

  workerGlobal.process.env['NODE_ENV'] ??= nodeEnv;
}

function parseWorkerInitOptions(options: unknown): BrainstrikePGliteWorkerInitOptions {
  if (typeof options !== 'object' || options === null) {
    throw new Error('PGlite worker init options must be an object');
  }
  const candidate = options as Record<string, unknown>;
  const dataDir = candidate['dataDir'];
  if (dataDir !== undefined && typeof dataDir !== 'string') {
    throw new Error('PGlite worker dataDir must be a string when provided');
  }
  const relaxedDurability = candidate['relaxedDurability'];
  if (relaxedDurability !== undefined && typeof relaxedDurability !== 'boolean') {
    throw new Error('PGlite worker relaxedDurability must be a boolean when provided');
  }
  return {
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(relaxedDurability === undefined ? {} : { relaxedDurability }),
  };
}

void startPGliteWorker();

async function startPGliteWorker(): Promise<void> {
  ensureBrowserWorkerProcessEnv();
  const { worker } = await import('@electric-sql/pglite/worker');

  void worker({
    async init(options) {
      ensureBrowserWorkerProcessEnv();
      const [{ PGlite }, { pg_trgm: pgTrgm }, { vector }] = await Promise.all([
        import('@electric-sql/pglite'),
        import('@electric-sql/pglite/contrib/pg_trgm'),
        import('@electric-sql/pglite-pgvector'),
      ]);
      const workerOptions = parseWorkerInitOptions(options);
      // PGlite engine extensions run here; client-side extensions are installed by PGliteWorker.
      const pgliteOptions: PGliteOptions = {
        extensions: { vector, pg_trgm: pgTrgm },
      };
      if (workerOptions.dataDir !== undefined) {
        pgliteOptions.dataDir = workerOptions.dataDir;
      }
      if (workerOptions.relaxedDurability !== undefined) {
        pgliteOptions.relaxedDurability = workerOptions.relaxedDurability;
      }
      return new PGlite(pgliteOptions);
    },
  });
}
