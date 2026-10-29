import { ChevronLeft, PanelLeft } from 'lucide-react';
import type React from 'react';
import { Panel, type PanelImperativeHandle, Separator } from 'react-resizable-panels';
import { Button } from '../button';

interface ExplorerPanelProps {
  content: React.ReactNode;
  defaultSize: number | string;
  hideButtonRef: React.RefObject<HTMLButtonElement | null>;
  onHide: () => void;
  panelRef: React.RefObject<PanelImperativeHandle | null>;
}

export function ExplorerPanel({
  panelRef,
  content,
  hideButtonRef,
  onHide,
  defaultSize,
}: ExplorerPanelProps) {
  return (
    <>
      <Panel
        className="bg-background overflow-hidden"
        collapsedSize="0%"
        collapsible
        data-panel-id="explorer-panel"
        defaultSize={typeof defaultSize === 'number' ? `${defaultSize}%` : defaultSize}
        id="explorer-panel"
        maxSize="50%"
        minSize="15%"
        panelRef={panelRef}
      >
        <div className="h-full overflow-hidden">
          <div className="border-border bg-muted/30 flex items-center justify-between border-b px-2 py-2">
            <div className="flex items-center gap-2">
              <PanelLeft className="h-4 w-4" />
              <span className="text-sm font-medium">Explorer</span>
            </div>
            <Button
              aria-label="Hide explorer panel"
              className="h-6 w-6"
              data-testid="hide-explorer-panel"
              onClick={onHide}
              ref={hideButtonRef}
              size="icon"
              title="Hide explorer panel"
              variant="ghost"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <div className="h-[calc(100%-2.5rem)] overflow-hidden">{content}</div>
        </div>
      </Panel>
      <Separator className="bg-border hover:bg-border/80 z-10 w-1 transition-colors" />
    </>
  );
}
