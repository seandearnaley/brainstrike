import { ChevronRight, PanelRight } from 'lucide-react';
import type React from 'react';
import { Panel, type PanelImperativeHandle, Separator } from 'react-resizable-panels';
import { Button } from '../button';

interface ToolsPanelProps {
  content: React.ReactNode;
  defaultSize: number | string;
  hideButtonRef: React.RefObject<HTMLButtonElement | null>;
  onHide: () => void;
  panelRef: React.RefObject<PanelImperativeHandle | null>;
}

export function ToolsPanel({
  panelRef,
  content,
  hideButtonRef,
  onHide,
  defaultSize,
}: ToolsPanelProps) {
  return (
    <>
      <Separator className="bg-border hover:bg-border/80 z-10 w-1 transition-colors" />
      <Panel
        className="bg-background"
        collapsedSize="0%"
        collapsible
        data-panel-id="tools-panel"
        defaultSize={typeof defaultSize === 'number' ? `${defaultSize}%` : defaultSize}
        id="tools-panel"
        maxSize="60%"
        minSize="15%"
        panelRef={panelRef}
      >
        <div className="border-border h-full border-l">
          <div className="border-border bg-muted/30 flex items-center justify-between border-b p-2">
            <div className="flex items-center gap-2">
              <PanelRight className="h-4 w-4" />
              <span className="text-sm font-medium">Tools</span>
            </div>
            <Button
              aria-label="Hide tools panel"
              className="h-6 w-6"
              data-testid="hide-tools-panel"
              onClick={onHide}
              ref={hideButtonRef}
              size="icon"
              title="Hide tools panel"
              variant="ghost"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex h-[calc(100%-2.5rem)] flex-col overflow-hidden">{content}</div>
        </div>
      </Panel>
    </>
  );
}
