import { useState } from 'react';
import { BrainstrikeMark } from './components/brainstrike-mark';
import { DownloadChooser, DownloadDialog } from './components/download-chooser';
import { SectionFrame } from './components/section-frame';
import { StageRail } from './components/stage-rail';
import {
  PRODUCT_HEADER_NAV,
  PRODUCT_STAGE_RAIL,
  PRODUCT_STORY,
  type ProductStoryStage,
  SIGNAL_STAGE,
  STORY_CHAPTERS,
  sceneAnchorId,
} from './content/product-story';
import { type ReleaseManifestState, useReleaseManifest } from './releases/use-release-manifest';
import { sceneFormationIndex } from './scene/scene-formations';
import { useSceneTimeline } from './scene/use-scene-timeline';
import { useSectionNavigation } from './scene/use-section-navigation';
import { WebGPUCanvas } from './scene/webgpu-canvas';

interface HeaderProps {
  readonly onDownload: () => void;
}

function Header({ onDownload }: HeaderProps) {
  return (
    <header className="site-header">
      <a aria-label="Brainstrike home" className="brand-lockup" href={`#${SIGNAL_STAGE.id}`}>
        <BrainstrikeMark className="brand-mark" />
        <span>Brainstrike</span>
        <sup>01</sup>
      </a>
      <nav aria-label="Primary navigation" className="header-nav">
        {PRODUCT_HEADER_NAV.map((item) => (
          <a href={`#${item.id}`} key={item.id}>
            {item.label}
          </a>
        ))}
      </nav>
      <button
        className="header-download"
        onClick={(event) => {
          event.currentTarget.focus();
          onDownload();
        }}
        type="button"
      >
        Download <span aria-hidden="true">↓</span>
      </button>
    </header>
  );
}

interface HeroProps {
  readonly onDownload: () => void;
  readonly stage: Extract<ProductStoryStage, { readonly kind: 'hero' }>;
}

function Hero({ onDownload, stage }: HeroProps) {
  return (
    <section className="hero" id={stage.id}>
      <span
        aria-hidden="true"
        className="scene-anchor"
        data-scene-anchor
        data-scene-stage={sceneFormationIndex(stage.formation)}
        id={sceneAnchorId(stage)}
      />
      <div className="hero-copy">
        <p className="eyebrow">LOCAL-FIRST / AI-NATIVE / DESKTOP</p>
        <h1>
          Intelligence,
          <br />
          <em>routed</em> through
          <br />
          your workspace.
        </h1>
        <p className="hero-description">
          Brainstrike is a serious desktop workspace where files, context, models, tools, memory,
          and agents operate as one inspectable system.
        </p>
        <div className="hero-actions">
          <button
            className="primary-action"
            onClick={(event) => {
              event.currentTarget.focus();
              onDownload();
            }}
            type="button"
          >
            Choose your build <span aria-hidden="true">↓</span>
          </button>
          <a className="text-action" href={`#${STORY_CHAPTERS[0].id}`}>
            Enter the system <span aria-hidden="true">↘</span>
          </a>
        </div>
      </div>
      <ul aria-label="Supported desktop platforms" className="hero-platforms">
        <li>macOS</li>
        <li>Windows</li>
        <li>Linux</li>
      </ul>
      <div aria-hidden="true" className="hero-telemetry">
        <span>WEBGPU / COMPUTE</span>
        <span>ADAPTIVE SIGNAL FIELD</span>
        <span>SCROLL / MEASURED</span>
      </div>
    </section>
  );
}

interface ClosingProps {
  readonly manifestState: ReleaseManifestState;
  readonly onDownload: () => void;
  readonly onRetry: () => void;
  readonly stage: Extract<ProductStoryStage, { readonly kind: 'closing' }>;
}

function Closing({ manifestState, onDownload, onRetry, stage }: ClosingProps) {
  const releasesHubUrl =
    manifestState.status === 'ready'
      ? manifestState.manifest.distribution?.releasesHubUrl
      : undefined;
  return (
    <section className="closing" data-scroll-section id={stage.id}>
      <span
        aria-hidden="true"
        className="scene-anchor"
        data-scene-anchor
        data-scene-stage={sceneFormationIndex(stage.formation)}
        id={sceneAnchorId(stage)}
      />
      <div className="closing-intro">
        <p className="eyebrow">RESOLVED OUTPUT / 07</p>
        <h2>
          Brainstrike lives
          <br />
          <em>on your machine.</em>
        </h2>
        <p>
          The workspace, threads, indexes, prompts, and continuity resolve where the work began.
          Choose a platform when a signed release is available.
        </p>
      </div>
      <DownloadChooser
        manifestState={manifestState}
        onOpenFull={onDownload}
        onRetry={onRetry}
        presentation="terminal"
      />
      <footer className="site-footer" role="contentinfo">
        <a className="brand-lockup" href={`#${SIGNAL_STAGE.id}`}>
          <BrainstrikeMark className="brand-mark" />
          <span>Brainstrike</span>
        </a>
        <p>Local-first workspace systems.</p>
        {releasesHubUrl ? (
          <a href={releasesHubUrl} rel="noreferrer" target="_blank">
            Public releases ↗
          </a>
        ) : (
          <span>Public release / pending</span>
        )}
      </footer>
    </section>
  );
}

interface ProductStoryStageViewProps {
  readonly manifestState: ReleaseManifestState;
  readonly onDownload: () => void;
  readonly onRetry: () => void;
  readonly ordinal: number;
  readonly stage: ProductStoryStage;
}

function ProductStoryStageView({
  manifestState,
  onDownload,
  onRetry,
  ordinal,
  stage,
}: ProductStoryStageViewProps) {
  switch (stage.kind) {
    case 'hero':
      return <Hero onDownload={onDownload} stage={stage} />;
    case 'chapter':
      return <SectionFrame ordinal={ordinal} stage={stage} />;
    case 'closing':
      return (
        <Closing
          manifestState={manifestState}
          onDownload={onDownload}
          onRetry={onRetry}
          stage={stage}
        />
      );
    default: {
      const unsupportedStage: never = stage;
      throw new Error(`Unsupported product story stage: ${String(unsupportedStage)}.`);
    }
  }
}

export default function App() {
  const [downloadOpen, setDownloadOpen] = useState(false);
  const releaseManifest = useReleaseManifest();
  const { activeStage, getSceneState } = useSceneTimeline();
  useSectionNavigation();

  return (
    <>
      <WebGPUCanvas getSceneState={getSceneState} />
      <Header onDownload={() => setDownloadOpen(true)} />
      <StageRail activeStage={activeStage} stages={PRODUCT_STAGE_RAIL} />
      <DownloadDialog
        manifestState={releaseManifest.state}
        onClose={() => setDownloadOpen(false)}
        onRetry={releaseManifest.retry}
        open={downloadOpen}
      />

      <main id="main">
        {PRODUCT_STORY.map((stage, index) => (
          <ProductStoryStageView
            key={stage.id}
            manifestState={releaseManifest.state}
            onDownload={() => setDownloadOpen(true)}
            onRetry={releaseManifest.retry}
            ordinal={index + 1}
            stage={stage}
          />
        ))}
      </main>
    </>
  );
}
