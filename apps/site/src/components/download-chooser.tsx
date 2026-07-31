import { useEffect, useRef } from 'react';
import { assetsForPlatform, type ReleasePlatform } from '../releases/release-manifest';
import type { ReleaseManifestState } from '../releases/use-release-manifest';

const RELEASES_HUB = 'https://github.com/seandearnaley/brainstrike/releases';

interface PlatformDefinition {
  readonly architecture: string;
  readonly format: string;
  readonly glyph: string;
  readonly name: string;
  readonly platform: ReleasePlatform;
}

const PLATFORMS: readonly PlatformDefinition[] = [
  {
    architecture: 'Apple silicon + Intel',
    format: 'DMG',
    glyph: '⌘',
    name: 'macOS',
    platform: 'macos',
  },
  {
    architecture: 'x64',
    format: 'EXE / NSIS',
    glyph: '⊞',
    name: 'Windows',
    platform: 'windows',
  },
  {
    architecture: 'x64',
    format: 'AppImage',
    glyph: '△',
    name: 'Linux',
    platform: 'linux',
  },
];

interface DownloadChooserProps {
  readonly manifestState: ReleaseManifestState;
}

export function DownloadChooser({ manifestState }: DownloadChooserProps) {
  const manifest = manifestState.status === 'ready' ? manifestState.manifest : null;
  const published = manifest?.latest !== null && manifest?.latest !== undefined;

  return (
    <div className="download-chooser">
      <div className="download-status-line">
        <span className={`status-dot ${published ? 'status-dot-live' : ''}`} />
        {manifestState.status === 'loading' ? <span>Reading release manifest…</span> : null}
        {manifestState.status === 'error' ? (
          <span role="alert">Manifest error: {manifestState.error}</span>
        ) : null}
        {manifestState.status === 'ready' && !published ? (
          <span>No executable has been published yet. Packaging targets are configured.</span>
        ) : null}
        {published ? <span>Latest stable build: {manifest?.latest?.tag}</span> : null}
      </div>

      <div className="platform-grid">
        {PLATFORMS.map((definition) => {
          const assets = manifest ? assetsForPlatform(manifest, definition.platform) : [];
          return (
            <article className="platform-option" key={definition.platform}>
              <span aria-hidden="true" className="platform-glyph">
                {definition.glyph}
              </span>
              <div>
                <h3>{definition.name}</h3>
                <p>
                  {definition.format} <span>/</span> {definition.architecture}
                </p>
              </div>
              <div className="platform-action">
                {assets.length > 0
                  ? assets.map((asset) => (
                      <a href={asset.url} key={asset.name}>
                        {asset.architecture} {asset.format}
                        <span aria-hidden="true"> ↓</span>
                      </a>
                    ))
                  : null}
                {assets.length === 0 && manifestState.status !== 'loading' ? (
                  <a href={manifest?.releasesHub ?? RELEASES_HUB} rel="noreferrer" target="_blank">
                    Releases hub <span aria-hidden="true">↗</span>
                  </a>
                ) : null}
                {manifestState.status === 'loading' ? <span>Checking…</span> : null}
              </div>
            </article>
          );
        })}
      </div>
      <p className="release-integrity-note">
        Direct downloads appear only when the release manifest names a real GitHub asset.
      </p>
    </div>
  );
}

interface DownloadDialogProps extends DownloadChooserProps {
  readonly onClose: () => void;
  readonly open: boolean;
}

export function DownloadDialog({ manifestState, onClose, open }: DownloadDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
      return;
    }
    if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      aria-labelledby="download-dialog-title"
      className="download-dialog"
      onCancel={onClose}
      onClose={onClose}
      ref={dialogRef}
    >
      <div className="download-dialog-shell">
        <header>
          <div>
            <span className="eyebrow">BUILD SELECTOR / STABLE</span>
            <h2 id="download-dialog-title">Choose your machine.</h2>
          </div>
          <button
            aria-label="Close download chooser"
            className="dialog-close"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>
        <DownloadChooser manifestState={manifestState} />
      </div>
    </dialog>
  );
}
