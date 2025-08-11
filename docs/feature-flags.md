# Feature flags

## File Explorer V2

**Precedence (highest → lowest):**
1) URL param: `?ff_explorer_v2=1|true|yes|on` (or `0|false|no|off`)
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


