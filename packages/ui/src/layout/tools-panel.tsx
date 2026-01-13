import { ChevronRight, PanelRight } from 'lucide-react';
import type React from 'react';
import { Panel, type PanelImperativeHandle, Separator } from 'react-resizable-panels';
import { Button } from '../button';

interface ToolsPanelProps {
  panelRef: React.RefObject<PanelImperativeHandle | null>;
  content: React.ReactNode;
  hideButtonRef: React.RefObject<HTMLButtonElement | null>;
  onHide: () => void;
  defaultSize: number | string;
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
      <Separator className="w-1 bg-border transition-colors hover:bg-border/80" />
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
        <div className="h-full border-border border-l">
          <div className="flex items-center justify-between border-border border-b bg-muted/30 p-2">
            <div className="flex items-center gap-2">
              <PanelRight className="h-4 w-4" />
              <span className="font-medium text-sm">Tools</span>
            </div>
            <Button
              aria-label="Hide tools panel"
              className="h-6 w-6"
              data-testid="hide-tools-panel"
              onClick={onHide}
              ref={hideButtonRef}
              size="icon"
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
