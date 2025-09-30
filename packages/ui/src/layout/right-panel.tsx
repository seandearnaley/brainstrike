import { ChevronRight, PanelRight } from 'lucide-react';
import type React from 'react';
import { type ImperativePanelHandle, Panel, PanelResizeHandle } from 'react-resizable-panels';
import { Button } from '../button';

interface RightPanelProps {
  panelRef: React.RefObject<ImperativePanelHandle | null>;
  content: React.ReactNode;
  hideButtonRef: React.RefObject<HTMLButtonElement | null>;
  onHide: () => void;
  defaultSize: number;
  onCollapse: () => void;
  onExpand: (size?: number) => void;
}

export function RightPanel({
  panelRef,
  content,
  hideButtonRef,
  onHide,
  defaultSize,
  onCollapse,
  onExpand,
}: RightPanelProps) {
  return (
    <>
      <PanelResizeHandle className="w-1 bg-border hover:bg-border/80 transition-colors" />
      <Panel
        ref={panelRef}
        id="right-panel"
        data-panel-id="right-panel"
        order={3}
        defaultSize={defaultSize}
        minSize={15}
        maxSize={60}
        collapsible
        collapsedSize={0}
        onCollapse={onCollapse}
        onExpand={onExpand}
        className="bg-background"
        style={{ overflow: 'clip' }}
      >
        <div className="h-full border-l border-border">
          <div className="flex items-center justify-between p-2 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2">
              <PanelRight className="h-4 w-4" />
              <span className="text-sm font-medium">Panel</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onHide}
              aria-label="Hide right panel"
              data-testid="hide-right-panel"
              ref={hideButtonRef}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="h-[calc(100%-2.5rem)] overflow-hidden flex flex-col">{content}</div>
        </div>
      </Panel>
    </>
  );
}
