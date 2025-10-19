import type { ChunkingStrategy } from '@brainstrike/db';
import { SimpleEmbeddingService } from '@brainstrike/embeddings';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import type { SettingsPanelProps } from '../types';

const AVAILABLE_MODELS = SimpleEmbeddingService.listModels();

export function SettingsPanel({ importSettings }: SettingsPanelProps) {
  const chunkingId = 'enable-chunking';
  const embeddingsId = 'enable-embeddings';
  const tokenSizingId = 'enable-token-true-sizing';
  const presetCaps = ['2048', '4096', '6144', '8192'];
  const selectedPreset = presetCaps.includes(String(importSettings.chunkTokenLimit))
    ? String(importSettings.chunkTokenLimit)
    : 'custom';
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

        <div>
          <Label className="text-xs" htmlFor={embeddingsId}>
            Embeddings
          </Label>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="checkbox"
              id={embeddingsId}
              checked={importSettings.enableEmbedding}
              onChange={(e) => importSettings.setEnableEmbedding(e.target.checked)}
              className="h-3 w-3"
            />
            <Select
              value={importSettings.selectedModel}
              onValueChange={importSettings.setSelectedModel}
            >
              <SelectTrigger className="h-6 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(AVAILABLE_MODELS).map(([key, model]) => (
                  <SelectItem key={key} value={key} className="text-xs">
                    {model.name}
                  </SelectItem>
                ))}
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

      <div className="flex items-center gap-2 pt-1">
        <input
          type="checkbox"
          id={tokenSizingId}
          checked={importSettings.tokenTrueSizing}
          onChange={(e) => importSettings.setTokenTrueSizing(e.target.checked)}
          className="h-3 w-3"
        />
        <Label className="text-xs" htmlFor={tokenSizingId}>
          Accurate token sizing
        </Label>
      </div>

      <div>
        <Label className="text-xs">Token cap</Label>
        <div className="flex items-center gap-2 mt-1">
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
            <SelectTrigger className="h-6 text-xs w-28">
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
    </div>
  );
}
