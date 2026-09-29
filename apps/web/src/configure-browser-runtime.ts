import { configureBrowserRuntimeAccess } from '@brainstrike/app-state/stores/assistant-preferences-store';

// The hosted web CSP permits only its declared remote origins. Desktop owns a
// separate native runtime bridge; development retains direct local probing.
if (import.meta.env.PROD) {
  configureBrowserRuntimeAccess(
    'This web app does not permit direct connections to local runtimes. Use the desktop app to connect to Ollama or LM Studio.'
  );
}
