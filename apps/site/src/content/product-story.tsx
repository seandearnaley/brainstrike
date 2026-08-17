import type { ComponentType } from 'react';
import { AgentReadout } from '../components/instruments/agent-readout';
import { ContextReadout } from '../components/instruments/context-readout';
import { MemoryArchive } from '../components/instruments/memory-archive';
import { ModelMatrix } from '../components/instruments/model-matrix';
import { RangeReadout } from '../components/instruments/range-readout';
import { RunTrace } from '../components/instruments/run-trace';
import type { SceneFormationId } from '../scene/scene-formations';

interface ProductStageBase {
  readonly formation: SceneFormationId;
  readonly headerLabel?: string;
  readonly id: string;
  readonly railLabel: string;
}

export interface ProductStoryChapter extends ProductStageBase {
  readonly code: string;
  readonly copy: string;
  readonly emphasis: string;
  readonly instrument: ComponentType;
  readonly kicker: string;
  readonly kind: 'chapter';
  readonly side: 'left' | 'right';
  readonly title: string;
}

interface ProductStoryBoundary extends ProductStageBase {
  readonly kind: 'closing' | 'hero';
}

export const SIGNAL_STAGE = {
  formation: 'signal',
  id: 'signal',
  kind: 'hero',
  railLabel: 'Signal',
} as const satisfies ProductStoryBoundary;

export const STORY_CHAPTERS = [
  {
    code: 'INGEST / 01',
    copy: 'Mount a workspace root and Brainstrike turns files, collections, and local indexes into addressable working context. Client-resident PGlite keeps the system close to the work.',
    emphasis: 'Keep the mind.',
    formation: 'ingest',
    headerLabel: 'System',
    id: 'context',
    instrument: ContextReadout,
    kicker: 'A WORKSPACE, NOT A CHAT WINDOW',
    kind: 'chapter',
    railLabel: 'Ingest',
    side: 'right',
    title: 'Mount the work.',
  },
  {
    code: 'CONTEXT / 02',
    copy: 'Exact search, BM25, embeddings, and curated file ranges meet in one context layer. Tapestry preserves the coordinates—file, line, and selection—so models receive evidence instead of a data dump.',
    emphasis: 'Keep precision.',
    formation: 'context',
    id: 'coordinates',
    instrument: RangeReadout,
    kicker: 'CONTEXT WITH COORDINATES',
    kind: 'chapter',
    railLabel: 'Context',
    side: 'left',
    title: 'Find meaning.',
  },
  {
    code: 'ROUTING / 03',
    copy: 'Define specialist personas, pin their models and tools, then delegate deliberately. Brainstrike discovers user agents from the workspace and routes bounded work through explicit subagent paths.',
    emphasis: 'Not the user.',
    formation: 'route',
    id: 'agents',
    instrument: AgentReadout,
    kicker: 'SPECIALISTS, WIRED IN',
    kind: 'chapter',
    railLabel: 'Route',
    side: 'right',
    title: 'Route the work.',
  },
  {
    code: 'TRACE / 04',
    copy: 'Native tools and MCP servers pass through permissions and approval state. Runs persist events, tool counts, model usage, edits, and outcomes—failed, mixed, or succeeded—without sanding off the failure.',
    emphasis: 'leaves a trace.',
    formation: 'trace',
    id: 'execution',
    instrument: RunTrace,
    kicker: 'EXECUTION YOU CAN READ',
    kind: 'chapter',
    railLabel: 'Trace',
    side: 'left',
    title: 'Every run',
  },
  {
    code: 'ARCHIVE / 05',
    copy: 'Threads and messages survive the session. Working memory, observational memory, prompts, and edit checkpoints preserve continuity while staying attached to the workspace that produced them.',
    emphasis: 'The system learns.',
    formation: 'memory',
    headerLabel: 'Continuity',
    id: 'memory',
    instrument: MemoryArchive,
    kicker: 'CONTINUITY WITHOUT AMNESIA',
    kind: 'chapter',
    railLabel: 'Memory',
    side: 'right',
    title: 'The thread holds.',
  },
  {
    code: 'MATRIX / 06',
    copy: 'Move between major hosted providers, the built-in local runtime, Ollama, and LM Studio. Routing follows real capabilities; unavailable models and broken connections surface as states, not invisible substitutions.',
    emphasis: 'Keep the instrument.',
    formation: 'matrix',
    headerLabel: 'Models',
    id: 'models',
    instrument: ModelMatrix,
    kicker: 'YOUR MODEL IS A ROUTE',
    kind: 'chapter',
    railLabel: 'Matrix',
    side: 'left',
    title: 'Choose the engine.',
  },
] as const satisfies readonly ProductStoryChapter[];

export const RESOLVE_STAGE = {
  formation: 'resolve',
  id: 'download',
  kind: 'closing',
  railLabel: 'Resolve',
} as const satisfies ProductStoryBoundary;

export const PRODUCT_STORY = [SIGNAL_STAGE, ...STORY_CHAPTERS, RESOLVE_STAGE] as const;

export type ProductStoryStage = (typeof PRODUCT_STORY)[number];
export type ProductStoryChapterStage = Extract<ProductStoryStage, { readonly kind: 'chapter' }>;

export interface ProductHeaderEntry {
  readonly id: ProductStoryStage['id'];
  readonly label: string;
}

export const PRODUCT_HEADER_NAV: readonly ProductHeaderEntry[] = PRODUCT_STORY.flatMap((stage) =>
  'headerLabel' in stage ? [{ id: stage.id, label: stage.headerLabel }] : []
);

export interface ProductStageRailEntry {
  readonly id: ProductStoryStage['id'];
  readonly railLabel: string;
}

export const PRODUCT_STAGE_RAIL: readonly ProductStageRailEntry[] = PRODUCT_STORY.map(
  ({ id, railLabel }) => ({ id, railLabel })
);

const SCENE_ANCHOR_SUFFIX = '-scene';

export function sceneAnchorId(stage: Pick<ProductStoryStage, 'id'>): string {
  return `${stage.id}${SCENE_ANCHOR_SUFFIX}`;
}

// Inverse of sceneAnchorId: scene anchors own the `${id}-scene` DOM ids, but
// consumers of the timeline (the stage rail) key on plain stage ids. Throws on
// a non-anchor id so a mismatch surfaces instead of silently deactivating the
// rail highlight.
export function stageIdFromSceneAnchor(anchorId: string): string {
  if (!anchorId.endsWith(SCENE_ANCHOR_SUFFIX)) {
    throw new Error(`"${anchorId}" is not a scene anchor id.`);
  }
  return anchorId.slice(0, -SCENE_ANCHOR_SUFFIX.length);
}
