import { type ActionOutcome, createClipboardService } from '@brainstrike/context-actions';
import {
  downloadBlobFile,
  formatTimestampedDownloadFilename,
} from '@brainstrike/utils/browser-download';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ParseError, render as renderTex } from 'katex';
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  FileCodeIcon,
  ImageIcon,
  Maximize2Icon,
  Minimize2Icon,
} from 'lucide-react';
import type { RenderResult } from 'pele';
import { type MathMarkup, type Mounted, type MountOptions, mountAsync } from 'pele/lazy';
import { type RefObject, use, useEffect, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { DIALOG_LAYER_CLASSES } from '../layers';
import { cn } from '../lib/utils';
import { TooltipProvider } from '../tooltip';
import { TooltipIconButton } from '../tooltip-icon-button';
import { toast } from '../use-toast';
import { DiagramFullSizeContainerContext } from './diagram-full-size-container';
import {
  DIAGRAM_PNG_SCALES,
  type DiagramBackground,
  type DiagramPngScale,
  diagramPng,
  fitsCanvas,
  pngSize,
  standaloneDiagram,
} from './mermaid-export';

const clipboard = createClipboardService();

/** Typesets `$$…$$` diagram labels with the KaTeX the Markdown math uses
 * (default `trust: false`). Pele sizes each label from the returned box, so the
 * MathML is measured in a hidden probe at the label's font size, and only the
 * `<math>` element is returned (Pele's KaTeX guidance). Malformed TeX returns
 * null, which leaves the TeX source visible in the label. */
function typesetMath(tex: string, size: number): MathMarkup | null {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;left:-9999px;visibility:hidden;display:inline-block;white-space:nowrap;font-size:${size}px`;
  document.body.append(probe);
  try {
    renderTex(tex, probe, { displayMode: true, output: 'mathml' });
    const expression = probe.querySelector('math');
    if (!expression) {
      return null;
    }
    const { height, width } = expression.getBoundingClientRect();
    return { height, html: expression.outerHTML, width };
  } catch (error) {
    if (error instanceof ParseError) {
      return null;
    }
    throw error;
  } finally {
    probe.remove();
  }
}

/** The diagram a view has drawn: its live `<svg>` and Pele's result for it. */
interface DrawnDiagram {
  readonly live: SVGSVGElement;
  readonly result: RenderResult;
}

type ReadDrawn = () => DrawnDiagram | null;

interface ExportOptions {
  readonly background: DiagramBackground;
  readonly scale: DiagramPngScale;
}

/** Draws `code` into a host Pele owns and exposes what it drew through `drawn`. */
function DiagramCanvas({
  className,
  code,
  drawn,
  zoom,
}: {
  readonly className?: string;
  readonly code: string;
  readonly drawn: RefObject<ReadDrawn | null>;
  readonly zoom?: MountOptions['zoom'];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Remounted per `code` (callers key the block), so each mount draws one source.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    let active = true;
    let diagram: Mounted | undefined;
    mountAsync(host, code, { math: typesetMath, ...(zoom === undefined ? {} : { zoom }) })
      .then((mounted) => {
        diagram = mounted;
        if (!active) {
          mounted.destroy();
          return;
        }
        drawn.current = () => {
          // The diagram's root carries the `pele` class; the zoom buttons' icons do not.
          const live = host.querySelector('svg.pele');
          const { result } = mounted;
          return live instanceof SVGSVGElement && result && mounted.error === undefined
            ? { live, result }
            : null;
        };
      })
      .catch((error: unknown) => {
        // Only loading the diagram type's chunk rejects; draw errors show in the host.
        if (active) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      active = false;
      drawn.current = null;
      diagram?.destroy();
    };
  }, [code, drawn, zoom]);

  if (loadError !== null) {
    return (
      <p className="not-prose text-destructive text-sm" data-testid="mermaid-error">
        Diagram renderer failed to load: {loadError}
      </p>
    );
  }
  return <div className={className} data-testid="mermaid-diagram" ref={hostRef} />;
}

function readOrThrow(read: ReadDrawn): DrawnDiagram {
  const drawn = read();
  if (!drawn) {
    throw new Error('The diagram has not been drawn');
  }
  return drawn;
}

function reportFailure(title: string, error: unknown) {
  toast({
    description: error instanceof Error ? error.message : String(error),
    title,
    variant: 'destructive',
  });
}

async function downloadDiagram(
  read: ReadDrawn,
  format: 'png' | 'svg',
  { background, scale }: ExportOptions
) {
  const { live, result } = readOrThrow(read);
  const diagram = await standaloneDiagram(live, result, background);
  const blob =
    format === 'png'
      ? await diagramPng(diagram, scale)
      : new Blob([diagram.svg], { type: 'image/svg+xml' });
  const filename = formatTimestampedDownloadFilename({
    extension: format,
    generatedAt: new Date(),
    name: `${result.type}-diagram`,
    suffix: format === 'png' ? `${scale}x` : null,
  });
  const { path } = await downloadBlobFile({ blob, filename });
  toast({ description: path ?? filename, title: 'Diagram saved' });
}

/**
 * Copy image, a download menu (PNG at a chosen scale, or SVG, on the theme's
 * background or transparent, plus the Mermaid source) and the full-size
 * toggle. The PNG and SVG keep the layout the reader is looking at.
 */
function DiagramToolbar({
  className,
  code,
  fullSize,
  onOptionsChange,
  options,
  read,
}: {
  readonly className?: string;
  readonly code: string;
  readonly fullSize: boolean;
  readonly onOptionsChange: (options: ExportOptions) => void;
  readonly options: ExportOptions;
  readonly read: ReadDrawn;
}) {
  const [copied, setCopied] = useState<'image' | 'source' | null>(null);
  const [size, setSize] = useState<Pick<RenderResult, 'height' | 'width'> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const settleCopy = (what: 'image' | 'source', outcome: ActionOutcome) => {
    if (!outcome.ok) {
      reportFailure('Could not copy the diagram', outcome.error);
      return;
    }
    if (what === 'source') {
      // The menu has closed, so the toolbar has nowhere to show it.
      toast({ title: 'Mermaid source copied' });
    }
    setCopied(what);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 2000);
  };

  const copyImage = () => {
    // Started inside the click so the web clipboard keeps the user's gesture;
    // the PNG is drawn while the write waits for it.
    const png = (async () => {
      const { live, result } = readOrThrow(read);
      return await diagramPng(
        await standaloneDiagram(live, result, options.background),
        options.scale
      );
    })();
    void clipboard.writeImage(png).then((outcome) => settleCopy('image', outcome));
  };

  const download = (format: 'png' | 'svg') => {
    downloadDiagram(read, format, options).catch((error: unknown) =>
      reportFailure('Could not save the diagram', error)
    );
  };

  // Choosing an option keeps the menu open, so the download is one more click.
  const keepOpen = (event: Event) => event.preventDefault();

  return (
    // Matches the app shell's tooltip timing; the block also renders outside it.
    <TooltipProvider delayDuration={300} skipDelayDuration={100}>
      <div
        aria-label="Diagram"
        className={cn('flex items-center gap-0.5', className)}
        role="toolbar"
      >
        <TooltipIconButton
          className="size-7"
          onClick={copyImage}
          tooltip={copied === 'image' ? 'Copied!' : 'Copy image'}
        >
          {copied === 'image' ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
        </TooltipIconButton>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              setSize(read()?.result ?? null);
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <TooltipIconButton className="size-7" tooltip="Download">
              <DownloadIcon className="size-4" />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem disabled={!size} onSelect={() => download('png')}>
              <ImageIcon />
              <span className="flex-1">Download PNG</span>
              {size ? (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {pngSize(size, options.scale).width} × {pngSize(size, options.scale).height}
                </span>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!size} onSelect={() => download('svg')}>
              <FileCodeIcon />
              Download SVG
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              PNG scale
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              onValueChange={(value) =>
                onOptionsChange({ ...options, scale: Number(value) as DiagramPngScale })
              }
              value={String(options.scale)}
            >
              {DIAGRAM_PNG_SCALES.map((scale) => (
                <DropdownMenuRadioItem
                  disabled={size !== null && !fitsCanvas(size, scale)}
                  key={scale}
                  onSelect={keepOpen}
                  value={String(scale)}
                >
                  {scale}×
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Background
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              onValueChange={(value) =>
                onOptionsChange({ ...options, background: value as DiagramBackground })
              }
              value={options.background}
            >
              <DropdownMenuRadioItem onSelect={keepOpen} value="theme">
                Theme
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem onSelect={keepOpen} value="transparent">
                Transparent
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                void clipboard.writeText(code).then((outcome) => settleCopy('source', outcome));
              }}
            >
              <CopyIcon />
              Copy Mermaid source
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {fullSize ? (
          <DialogPrimitive.Close asChild>
            <TooltipIconButton className="size-7" tooltip="Exit full size">
              <Minimize2Icon className="size-4" />
            </TooltipIconButton>
          </DialogPrimitive.Close>
        ) : (
          <DialogPrimitive.Trigger asChild>
            <TooltipIconButton className="size-7" tooltip="Full size">
              <Maximize2Icon className="size-4" />
            </TooltipIconButton>
          </DialogPrimitive.Trigger>
        )}
        {/* The tooltips are not announced; outcomes are. */}
        <span aria-live="polite" className="sr-only" role="status">
          {copied === 'image' ? 'Diagram image copied' : null}
          {copied === 'source' ? 'Mermaid source copied' : null}
        </span>
      </div>
    </TooltipProvider>
  );
}

// Module scope: a stable identity, so the full-size view does not redraw.
const FULL_SIZE_ZOOM = { always: true, maxScale: 8 } as const;

/**
 * The diagram filling the surface's full-size container (the chat panel) or,
 * without one, the window. It is non-modal: the rest of the app stays usable,
 * so dragging the panel's edge resizes it and Pele lays the diagram out again
 * for the new width. Escape or the toolbar's button closes it.
 */
function DiagramFullSizeView({
  code,
  onOptionsChange,
  options,
}: {
  readonly code: string;
  readonly onOptionsChange: (options: ExportOptions) => void;
  readonly options: ExportOptions;
}) {
  const container = use(DiagramFullSizeContainerContext);
  const drawn = useRef<ReadDrawn | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          container ? 'absolute' : 'fixed',
          'inset-0 flex flex-col bg-background outline-hidden',
          DIALOG_LAYER_CLASSES[0].content
        )}
        data-testid="mermaid-full-size"
        // Clicks and focus elsewhere (the panel's resize handle) leave it open.
        onInteractOutside={(event) => event.preventDefault()}
        // Focus the view itself: focusing its first button would open that
        // button's tooltip, and the first Escape would close only the tooltip.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus();
        }}
        ref={contentRef}
      >
        <div className="flex items-center gap-3 border-border border-b px-3 py-1.5">
          <DialogPrimitive.Title className="font-medium text-sm">Diagram</DialogPrimitive.Title>
          <p className="truncate text-muted-foreground text-xs">
            Pinch or Ctrl + scroll to zoom, drag to pan, double-click to zoom in or reset
          </p>
          <DiagramToolbar
            className="ml-auto"
            code={code}
            fullSize
            onOptionsChange={onOptionsChange}
            options={options}
            read={() => drawn.current?.() ?? null}
          />
        </div>
        <div className="min-h-0 flex-1 p-4">
          <DiagramCanvas
            className="bs-diagram-full-size not-prose h-full w-full overflow-hidden"
            code={code}
            drawn={drawn}
            zoom={FULL_SIZE_ZOOM}
          />
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/** Renders a ```mermaid fence with Pele. Pele owns the host's DOM: it lays the
 * diagram out for the container width, redraws on resize and web-font loads,
 * and shows a parse error (message plus the marked source line) in place of
 * the diagram — a broken diagram must say why. Colors come from the `.pele`
 * rules in globals.css, so theme switches restyle without a re-render. Each
 * diagram type loads on first use. A toolbar over the diagram copies or saves
 * it as an image and opens it full size. */
export function MermaidBlock({ code }: { readonly code: string }) {
  const drawn = useRef<ReadDrawn | null>(null);
  const [options, setOptions] = useState<ExportOptions>({ background: 'theme', scale: 2 });
  return (
    // Non-modal: see DiagramFullSizeView.
    <DialogPrimitive.Root modal={false}>
      {/* Pele's zoom buttons move to the bottom corner, clear of the toolbar. */}
      <div className="not-prose group/diagram relative [--pele-zoom-bottom:8px] [--pele-zoom-top:auto]">
        <DiagramCanvas className="not-prose" code={code} drawn={drawn} />
        <DiagramToolbar
          className="absolute top-1 right-1 rounded-md bg-background/90 opacity-0 shadow-xs transition-opacity focus-within:opacity-100 group-hover/diagram:opacity-100 has-[[data-state=open]]:opacity-100"
          code={code}
          fullSize={false}
          onOptionsChange={setOptions}
          options={options}
          read={() => drawn.current?.() ?? null}
        />
      </div>
      <DiagramFullSizeView code={code} onOptionsChange={setOptions} options={options} />
    </DialogPrimitive.Root>
  );
}
