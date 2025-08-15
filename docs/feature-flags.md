# Feature flags

## File Explorer V2

**Precedence (highest → lowest):**
1) URL param: `?ff_explorer_v2` (presence = ON) or `?ff_explorer_v2=1|true|yes|on` (or `0|false|no|off`)
2) `localStorage`: key `FEATURE_FILE_EXPLORER_V2` with value `1`/`0`
3) Env:
   - Web/Vite: `VITE_FILE_EXPLORER_V2=1`
   - Desktop: `BRAINSTRIKE_URL_PARAMS="ff_explorer_v2=1"`

**Desktop CLI switches:**
- `--ff_explorer_v2` or `--ff_explorer_v2=1` → ON
- `--ff_explorer_v2=0` → OFF

**Where it shows up:**
- Settings → Experiments → “File Explorer V2”
- Sentinel testids:
  - `data-testid="explorer-v2-enabled"`
  - `data-testid="explorer-v2-disabled"`

**Examples**
- Web: `http://localhost:8080/?ff_explorer_v2=1`
- Desktop: `pnpm start -- --ff_explorer_v2=1`
- Desktop (env): `BRAINSTRIKE_URL_PARAMS="ff_explorer_v2=1" pnpm start`

### Notes

- V2 uses incremental visible rows; no global flatten on scroll. The visible list updates via single splice operations on expand/collapse and on filter commits (debounced). This behavior is guarded behind the V2 flag and does not affect V1.

## File Explorer V2 Worker Mode

**Precedence (highest → lowest):**
1) URL param: `?ff_explorer_v2_worker` (presence = ON) or `?ff_explorer_v2_worker=1|true|yes|on` (or `0|false|no|off`)
2) `localStorage`: key `FEATURE_FILE_EXPLORER_V2_WORKER` with value `1`/`0`
3) Env:
   - Web/Vite: `VITE_FILE_EXPLORER_V2_WORKER=1`
   - Desktop: `BRAINSTRIKE_URL_PARAMS="ff_explorer_v2_worker=1"`

**Desktop CLI switches:**
- `--ff_explorer_v2_worker` or `--ff_explorer_v2_worker=1` → ON
- `--ff_explorer_v2_worker=0` → OFF

**Requirements:**
- File Explorer V2 must be enabled (`ff_explorer_v2=1`)
- Browser environment with Web Worker support

**What it does:**
- Moves tree computation off the main thread to a dedicated Web Worker
- Computes single-splice diffs for expand/collapse operations
- Mirrors filter and expansion inputs in the worker and computes visible-row diffs based on them
- Falls back to main-thread computation on timeout (configurable; default 120ms in client)

**Examples:**
- Web: `http://localhost:8080/?ff_explorer_v2=1&ff_explorer_v2_worker=1`
- Desktop: `pnpm start -- --ff_explorer_v2=1 --ff_explorer_v2_worker=1`
- Desktop (env): `BRAINSTRIKE_URL_PARAMS="ff_explorer_v2=1&ff_explorer_v2_worker=1" pnpm start`

### Worker Mode Notes and gating

- Worker mode keeps the main thread free during expand/collapse and filter operations on large trees
- Calculates minimal single-splice diffs to reduce UI updates
- Performance metrics (calcMs, visibleCount, spliceCount) are tracked for monitoring
- Automatic fallback to main-thread computation if worker times out or fails

In code, worker usage is gated by a single helper and also checks for the platform capability:

```ts
import { shouldUseFileExplorerWorker } from '@brainstrike/app-shell';

const useWorker = shouldUseFileExplorerWorker();
```

### Local overrides

- localStorage: set `FEATURE_FILE_EXPLORER_V2_WORKER` to `'1'` or `'0'`
  ```js
  localStorage.setItem('FEATURE_FILE_EXPLORER_V2_WORKER','1');
  ```


