import { ChevronLeft, PanelLeft } from 'lucide-react';
import type React from 'react';
import { type ImperativePanelHandle, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '../button';

interface LeftPanelProps {
  panelRef: React.RefObject<ImperativePanelHandle | null>;
  content: React.ReactNode;
  hideButtonRef: React.RefObject<HTMLButtonElement | null>;
  onHide: () => void;
  defaultSize: number;
  onCollapse: () => void;
  onExpand: (size?: number) => void;
}

export function LeftPanel({
  panelRef,
  content,
  hideButtonRef,
  onHide,
  defaultSize,
  onCollapse,
  onExpand,
}: LeftPanelProps) {
  return (
    <>
      <Panel
        ref={panelRef}
        id="left-panel"
        data-panel-id="left-panel"
        order={1}
        defaultSize={defaultSize}
        minSize={15}
        maxSize={50}
        collapsible
        collapsedSize={0}
        onCollapse={onCollapse}
        onExpand={onExpand}
        className="bg-background"
      >
        <div className="h-full">
          <div className="flex items-center justify-between px-2 py-2 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2">
              <PanelLeft className="h-4 w-4" />
              <span className="text-sm font-medium">Explorer</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onHide}
              aria-label="Hide explorer"
              ref={hideButtonRef}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <div className="h-[calc(100%-2.5rem)] overflow-auto">{content}</div>
        </div>
      </Panel>
      <PanelResizeHandle className="w-1 bg-border hover:bg-border/80 transition-colors" />
    </>
  );
}
