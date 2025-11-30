import type { ChunkingStrategy, FileChunk, FileRecord } from '@brainstrike/db';
import { tokenPreferencesSelectors, useTokenPreferencesStore } from '@brainstrike/preferences';
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { Trash2 } from 'lucide-react';
import type { SettingsPanelProps } from '../types';

interface ExtendedSettingsPanelProps extends SettingsPanelProps {
  /** Clear database dialog controls - optional for backwards compatibility */
  clearDatabaseProps?: {
    clearAllData: (() => Promise<unknown>) | null;
    records: FileRecord[];
    chunks: FileChunk[];
    clearing: boolean;
    showClearDialog: boolean;
    setShowClearDialog: (show: boolean) => void;
    onClear: () => void;
  };
}

export function SettingsPanel({ importSettings, clearDatabaseProps }: ExtendedSettingsPanelProps) {
  const chunkingId = 'enable-chunking';
  const presetCaps = ['2048', '4096', '6144', '8192'];
  const selectedPreset = presetCaps.includes(String(importSettings.chunkTokenLimit))
    ? String(importSettings.chunkTokenLimit)
    : 'custom';
  const accurateCounting = useTokenPreferencesStore(tokenPreferencesSelectors.accurateCounting);
  return (
    <div className="mt-2 p-3 bg-muted/50 rounded space-y-3">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs" htmlFor={chunkingId}>
            Chunking
          </Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="checkbox"
              id={chunkingId}
              checked={importSettings.enableChunking}
              onChange={(e) => importSettings.setEnableChunking(e.target.checked)}
              className="h-3 w-3"
            />
            <Select
              value={importSettings.chunkingStrategy}
              onValueChange={(value) =>
                importSettings.setChunkingStrategy(value as ChunkingStrategy)
              }
            >
              <SelectTrigger className="h-6 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sentence">Sentence</SelectItem>
                <SelectItem value="token">Token</SelectItem>
                <SelectItem value="recursive">Recursive</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label className="text-xs">Chunk Size</Label>
          <Input
            type="number"
            value={importSettings.chunkSize}
            onChange={(e) => importSettings.setChunkSize(Number(e.target.value))}
            className="h-6 text-xs"
            min="128"
            max="2048"
          />
        </div>
        <div>
          <Label className="text-xs">Overlap</Label>
          <Input
            type="number"
            value={importSettings.chunkOverlap}
            onChange={(e) => importSettings.setChunkOverlap(Number(e.target.value))}
            className="h-6 text-xs"
            min="0"
            max="256"
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded border px-3 py-2">
        <div>
          <Label className="text-xs">Token sizing</Label>
          <p className="text-[10px] text-muted-foreground">
            Controlled globally via Settings → Token Counting.
          </p>
        </div>
        <Badge
          variant={accurateCounting ? 'secondary' : 'outline'}
          className="text-[10px] uppercase"
        >
          {accurateCounting ? 'WASM tokenizer' : 'Heuristic mode'}
        </Badge>
      </div>

      <div>
        <Label className="text-xs">Token cap</Label>
        <div className="grid grid-cols-2 gap-2 mt-1">
          <Input
            type="number"
            value={importSettings.chunkTokenLimit}
            onChange={(e) => importSettings.setChunkTokenLimit(Number(e.target.value) || 0)}
            className="h-6 text-xs"
            min="512"
            max="16384"
            step="128"
          />
          <Select
            value={selectedPreset}
            onValueChange={(value) => {
              if (value === 'custom') return;
              importSettings.setChunkTokenLimit(Number(value));
            }}
          >
            <SelectTrigger className="h-6 text-xs">
              <SelectValue placeholder="Presets" />
            </SelectTrigger>
            <SelectContent>
              {presetCaps.map((cap) => (
                <SelectItem key={cap} value={cap} className="text-xs">
                  {cap} tokens
                </SelectItem>
              ))}
              <SelectItem value="custom" className="text-xs">
                Custom
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          Higher caps reduce chunk count at the cost of larger embedding payloads.
        </p>
      </div>

      {/* Clear Database - Dangerous operation, placed at bottom of settings */}
      {clearDatabaseProps && (
        <div className="pt-3 mt-3 border-t border-border/50">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs text-muted-foreground">Danger Zone</Label>
              <p className="text-[10px] text-muted-foreground">
                Clear all imported files and chunks from database.
              </p>
            </div>
            <Button
              size="sm"
              variant="destructive"
              disabled={
                clearDatabaseProps.clearing ||
                !clearDatabaseProps.clearAllData ||
                (clearDatabaseProps.records.length === 0 && clearDatabaseProps.chunks.length === 0)
              }
              onClick={() => clearDatabaseProps.setShowClearDialog(true)}
              className="flex items-center gap-1 h-7"
            >
              <Trash2 className="h-3 w-3" />
              Clear Database
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
