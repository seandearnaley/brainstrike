import { ChevronLeft, PanelLeft } from 'lucide-react';
import type React from 'react';
import { type ImperativePanelHandle, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '../button';

type LeftPanelProps = {
  panelRef: React.RefObject<ImperativePanelHandle | null>;
  content: React.ReactNode;
  hideButtonRef: React.RefObject<HTMLButtonElement | null>;
  onHide: () => void;
  defaultSize: number;
  onCollapse: () => void;
  onExpand: (size?: number) => void;
};

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
        className="bg-background"
        collapsedSize={0}
        collapsible
        data-panel-id="left-panel"
        defaultSize={defaultSize}
        id="left-panel"
        maxSize={50}
        minSize={15}
        onCollapse={onCollapse}
        onExpand={onExpand}
        order={1}
        ref={panelRef}
      >
        <div className="h-full">
          <div className="flex items-center justify-between border-border border-b bg-muted/30 px-2 py-2">
            <div className="flex items-center gap-2">
              <PanelLeft className="h-4 w-4" />
              <span className="font-medium text-sm">Explorer</span>
            </div>
            <Button
              aria-label="Hide explorer"
              className="h-6 w-6"
              data-testid="hide-left-panel"
              onClick={onHide}
              ref={hideButtonRef}
              size="icon"
              variant="ghost"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <div className="h-[calc(100%-2.5rem)]">{content}</div>
        </div>
      </Panel>
      <PanelResizeHandle className="w-1 bg-border transition-colors hover:bg-border/80" />
    </>
  );
}
