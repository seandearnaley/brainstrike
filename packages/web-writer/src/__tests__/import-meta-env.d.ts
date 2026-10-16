/** The `VITE_*` variables Vite hands a browser test (`import.meta.env`). */
interface ImportMetaEnv {
  readonly [key: string]: boolean | string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
