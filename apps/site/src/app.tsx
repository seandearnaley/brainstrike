import { useState } from 'react';
import { BrainstrikeMark } from './components/brainstrike-mark';
import { DownloadChooser, DownloadDialog } from './components/download-chooser';
import { SectionFrame } from './components/section-frame';
import { type StageDefinition, StageRail } from './components/stage-rail';
import { useReleaseManifest } from './releases/use-release-manifest';
import { useSceneTimeline } from './scene/use-scene-timeline';
import { useSectionNavigation } from './scene/use-section-navigation';
import { WebGPUCanvas } from './scene/webgpu-canvas';

const STAGES: readonly StageDefinition[] = [
  { id: 'signal', label: 'Signal' },
  { id: 'context', label: 'Ingest' },
  { id: 'coordinates', label: 'Context' },
  { id: 'agents', label: 'Route' },
  { id: 'execution', label: 'Trace' },
  { id: 'memory', label: 'Memory' },
  { id: 'models', label: 'Matrix' },
  { id: 'download', label: 'Resolve' },
];

function Header({ onDownload }: { readonly onDownload: () => void }) {
  return (
    <header className="site-header">
      <a aria-label="Brainstrike home" className="brand-lockup" href="#signal">
        <BrainstrikeMark className="brand-mark" />
        <span>Brainstrike</span>
        <sup>01</sup>
      </a>
      <nav aria-label="Primary navigation" className="header-nav">
        <a href="#context">System</a>
        <a href="#memory">Continuity</a>
        <a href="#models">Models</a>
      </nav>
      <button className="header-download" onClick={onDownload} type="button">
        Download <span aria-hidden="true">↓</span>
      </button>
    </header>
  );
}

function ContextReadout() {
  return (
    <section aria-label="Workspace context readout" className="instrument-readout">
      <div className="readout-head">
        <span>CONTEXT BUS</span>
        <span className="readout-live">● LIVE</span>
      </div>
      <ol className="context-lines">
        <li>
          <span>01</span>
          <code>workspace://brainstrike</code>
          <em>MOUNTED</em>
        </li>
        <li>
          <span>02</span>
          <code>assistant-runtime.ts:L318—402</code>
          <em>RANGE</em>
        </li>
        <li>
          <span>03</span>
          <code>semantic + exact</code>
          <em>INDEXED</em>
        </li>
      </ol>
    </section>
  );
}

function RangeReadout() {
  return (
    <div className="range-readout">
      <pre aria-label="Selected context ranges" role="img">{`┌─ TAPESTRY / 03 RANGES ───────┐
│ src/stream.ts       42—118   │
│ src/guards.ts      201—276   │
│ tests/runtime.ts    88—132   │
└─ 8.4k TOKENS / PRECISE ─────┘`}</pre>
      <div className="query-path">
        <span>GREP</span>
        <i />
        <span>BM25</span>
        <i />
        <span>VECTOR</span>
      </div>
    </div>
  );
}

function AgentReadout() {
  return (
    <div className="agent-readout">
      <div className="agent-row agent-row-primary">
        <span>00</span>
        <strong>ORCHESTRATOR</strong>
        <em>ACTIVE</em>
      </div>
      <div className="agent-branches">
        <div>
          <span>01</span>
          <strong>RESEARCH</strong>
          <small>tools: 04</small>
        </div>
        <div>
          <span>02</span>
          <strong>REVIEW</strong>
          <small>model: pinned</small>
        </div>
        <div>
          <span>03</span>
          <strong>USER PERSONA</strong>
          <small>.brainstrike/agents</small>
        </div>
      </div>
    </div>
  );
}

function RunTrace() {
  return (
    <div className="run-trace">
      <div className="trace-header">
        <span>RUN / 019F_B3A2</span>
        <span>INSPECTABLE</span>
      </div>
      <ol>
        <li>
          <time>00:00.218</time>
          <span>memory.history.loaded</span>
          <em>12 messages</em>
        </li>
        <li>
          <time>00:01.042</time>
          <span>tool.approval.requested</span>
          <em className="trace-warn">held</em>
        </li>
        <li>
          <time>00:03.881</time>
          <span>tool.completed</span>
          <em>visible</em>
        </li>
        <li>
          <time>00:04.290</time>
          <span>outcome</span>
          <em className="trace-ok">succeeded</em>
        </li>
      </ol>
    </div>
  );
}

function MemoryArchive() {
  return (
    <div className="memory-archive">
      <div>
        <span>THREADS</span>
        <strong>durable</strong>
      </div>
      <div>
        <span>WORKING MEMORY</span>
        <strong>workspace scoped</strong>
      </div>
      <div>
        <span>PROMPTS</span>
        <strong>reusable</strong>
      </div>
      <div>
        <span>EDIT CHECKPOINTS</span>
        <strong>reversible</strong>
      </div>
    </div>
  );
}

function ModelMatrix() {
  return (
    <div className="model-matrix">
      <div className="matrix-column">
        <span>HOSTED</span>
        <strong>OpenAI</strong>
        <strong>Anthropic</strong>
        <strong>Google</strong>
        <strong>OpenRouter</strong>
      </div>
      <div className="matrix-divider" />
      <div className="matrix-column">
        <span>LOCAL</span>
        <strong>Built-in local</strong>
        <strong>Ollama</strong>
        <strong>LM Studio</strong>
        <small>capability detected</small>
      </div>
    </div>
  );
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
      <StageRail activeStage={activeStage} stages={STAGES} />
      <DownloadDialog
        manifestState={releaseManifest}
        onClose={() => setDownloadOpen(false)}
        open={downloadOpen}
      />

      <main id="main">
        <section className="hero" id="signal">
          <span
            aria-hidden="true"
            className="scene-anchor"
            data-scene-anchor
            data-scene-stage="0"
            id="signal-scene"
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
              Brainstrike is a serious desktop workspace where files, context, models, tools,
              memory, and agents operate as one inspectable system.
            </p>
            <div className="hero-actions">
              <button
                className="primary-action"
                onClick={() => setDownloadOpen(true)}
                type="button"
              >
                Choose your build <span aria-hidden="true">↓</span>
              </button>
              <a className="text-action" href="#context">
                Enter the system <span aria-hidden="true">↘</span>
              </a>
            </div>
          </div>
          <ul aria-label="Supported desktop platforms" className="hero-platforms">
            <li>macOS</li>
            <li>Windows</li>
            <li>Linux</li>
          </ul>
          <div className="hero-telemetry" role="status">
            <span>WEBGPU / COMPUTE</span>
            <span>12,288 SIGNAL NODES</span>
            <span>SCROLL / MEASURED</span>
          </div>
        </section>

        <SectionFrame
          code="INGEST / 01"
          copy="Mount a workspace root and Brainstrike turns files, collections, and local indexes into addressable working context. Client-resident PGlite keeps the system close to the work."
          id="context"
          kicker="A WORKSPACE, NOT A CHAT WINDOW"
          side="right"
          stage={1}
          title={
            <>
              Mount the work.
              <br />
              <em>Keep the mind.</em>
            </>
          }
        >
          <ContextReadout />
        </SectionFrame>

        <SectionFrame
          code="CONTEXT / 02"
          copy="Exact search, BM25, embeddings, and curated file ranges meet in one context layer. Tapestry preserves the coordinates—file, line, and selection—so models receive evidence instead of a data dump."
          id="coordinates"
          kicker="CONTEXT WITH COORDINATES"
          side="left"
          stage={2}
          title={
            <>
              Find meaning.
              <br />
              <em>Keep precision.</em>
            </>
          }
        >
          <RangeReadout />
        </SectionFrame>

        <SectionFrame
          code="ROUTING / 03"
          copy="Define specialist personas, pin their models and tools, then delegate deliberately. Brainstrike discovers user agents from the workspace and routes bounded work through explicit subagent paths."
          id="agents"
          kicker="SPECIALISTS, WIRED IN"
          side="right"
          stage={3}
          title={
            <>
              Route the work.
              <br />
              <em>Not the user.</em>
            </>
          }
        >
          <AgentReadout />
        </SectionFrame>

        <SectionFrame
          code="TRACE / 04"
          copy="Native tools and MCP servers pass through permissions and approval state. Runs persist events, tool counts, model usage, edits, and outcomes—failed, mixed, or succeeded—without sanding off the failure."
          id="execution"
          kicker="EXECUTION YOU CAN READ"
          side="left"
          stage={4}
          title={
            <>
              Every run
              <br />
              <em>leaves a trace.</em>
            </>
          }
        >
          <RunTrace />
        </SectionFrame>

        <SectionFrame
          code="ARCHIVE / 05"
          copy="Threads and messages survive the session. Working memory, observational memory, prompts, and edit checkpoints preserve continuity while staying attached to the workspace that produced them."
          id="memory"
          kicker="CONTINUITY WITHOUT AMNESIA"
          side="right"
          stage={5}
          title={
            <>
              The thread holds.
              <br />
              <em>The system learns.</em>
            </>
          }
        >
          <MemoryArchive />
        </SectionFrame>

        <SectionFrame
          code="MATRIX / 06"
          copy="Move between major hosted providers, the built-in local runtime, Ollama, and LM Studio. Routing follows real capabilities; unavailable models and broken connections surface as states, not invisible substitutions."
          id="models"
          kicker="YOUR MODEL IS A ROUTE"
          side="left"
          stage={6}
          title={
            <>
              Choose the engine.
              <br />
              <em>Keep the instrument.</em>
            </>
          }
        >
          <ModelMatrix />
        </SectionFrame>

        <section className="closing" data-scroll-section id="download">
          <span
            aria-hidden="true"
            className="scene-anchor"
            data-scene-anchor
            data-scene-stage="7"
            id="download-scene"
          />
          <div className="closing-intro" data-scroll-content>
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
          <DownloadChooser manifestState={releaseManifest} />
          <footer className="site-footer">
            <a className="brand-lockup" href="#signal">
              <BrainstrikeMark className="brand-mark" />
              <span>Brainstrike</span>
            </a>
            <p>Local-first workspace systems.</p>
            <a href="https://github.com/seandearnaley/brainstrike" rel="noreferrer" target="_blank">
              Source / GitHub ↗
            </a>
          </footer>
        </section>
      </main>
    </>
  );
}
