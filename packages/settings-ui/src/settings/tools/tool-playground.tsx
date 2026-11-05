/**
 * Tool Playground
 *
 * JSON editor and execution panel for testing tools.
 * Shows parameter schemas and allows tool testing.
 */

import {
  generateExampleInput,
  getToolSchemaDisplay,
  type ToolParameterDisplay,
  type ToolSchemaDisplay,
} from '@brainstrike/assistant-contract/tool-metadata';
import { Badge, Button } from '@brainstrike/ui';
import { ChevronDown, ChevronRight, Play, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { saveToolPlaygroundInput, useToolPlaygroundInputsStore } from './tool-playground-store.ts';
import type { ToolExecutionResult, ToolPlaygroundProps } from './types';

/**
 * Format a range label from min/max values.
 */
function formatRangeLabel(min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) {
    return `Range: ${min}-${max}`;
  }
  if (min !== undefined) {
    return `Min: ${min}`;
  }
  return `Max: ${max}`;
}

/**
 * Get type badge color based on parameter type.
 */
function getTypeBadgeVariant(type: string): 'default' | 'secondary' | 'outline' {
  switch (type) {
    case 'string':
      return 'secondary';
    case 'number':
      return 'default';
    case 'boolean':
      return 'outline';
    case 'array':
      return 'secondary';
    case 'enum':
      return 'default';
    default:
      return 'outline';
  }
}

/**
 * Single parameter display row.
 */
function ParameterRow({ param }: { param: ToolParameterDisplay }) {
  return (
    <div className="border-border/30 flex items-start gap-2 border-b py-1.5 last:border-0">
      <div className="flex min-w-[140px] items-center gap-1.5">
        <code className="text-foreground font-mono text-xs">{param.name}</code>
        {param.required && <span className="text-destructive text-xs">*</span>}
      </div>
      <Badge className="px-1.5 text-[9px]" variant={getTypeBadgeVariant(param.type)}>
        {param.type}
        {param.arrayItemType && `[${param.arrayItemType}]`}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground truncate text-xs">{param.description}</p>
        {param.enumValues && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {param.enumValues.map((value: string) => (
              <code className="bg-muted/50 rounded px-1 py-0.5 font-mono text-[10px]" key={value}>
                {value}
              </code>
            ))}
          </div>
        )}
        {(param.min !== undefined || param.max !== undefined) && (
          <span className="text-muted-foreground text-[10px]">
            {formatRangeLabel(param.min, param.max)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Parameters section with collapsible display.
 */
function ParametersSection({ schema }: { schema: ToolSchemaDisplay }) {
  const [expanded, setExpanded] = useState(true);
  const contentId = useId();
  const requiredParams = schema.parameters.filter((param: ToolParameterDisplay) => param.required);
  const optionalParams = schema.parameters.filter((param: ToolParameterDisplay) => !param.required);

  return (
    <div className="mb-3">
      <button
        aria-controls={expanded ? contentId : undefined}
        aria-expanded={expanded}
        className="text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1 text-xs font-medium"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Parameters ({schema.parameters.length})
      </button>

      {expanded && (
        <div className="border-border/50 bg-muted/20 rounded-md border p-2" id={contentId}>
          {requiredParams.length > 0 && (
            <div className="mb-2">
              <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                Required
              </span>
              <div className="mt-1">
                {requiredParams.map((param: ToolParameterDisplay) => (
                  <ParameterRow key={param.name} param={param} />
                ))}
              </div>
            </div>
          )}

          {optionalParams.length > 0 && (
            <div>
              <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                Optional
              </span>
              <div className="mt-1">
                {optionalParams.map((param: ToolParameterDisplay) => (
                  <ParameterRow key={param.name} param={param} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Returns section showing what the tool outputs.
 */
function ReturnsSection({ returns }: { returns: string }) {
  return (
    <div className="mb-3">
      <span className="text-muted-foreground text-xs font-medium">Returns</span>
      <p className="text-foreground mt-1 text-xs">{returns}</p>
    </div>
  );
}

/**
 * Tool Playground Component
 */
export function ToolPlayground({
  toolId,
  inputSchema: _inputSchema,
  onExecute,
}: ToolPlaygroundProps) {
  const input = useToolPlaygroundInputsStore((state) => state.inputsByToolId[toolId] ?? '{}');
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ToolExecutionResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  // Get schema display info for native tools
  const schemaDisplay = getToolSchemaDisplay(toolId);

  const handleInputChange = (value: string) => {
    saveToolPlaygroundInput(toolId, value);
    setParseError(null);
  };

  const handleGenerateExample = () => {
    if (schemaDisplay) {
      const example = generateExampleInput(schemaDisplay);
      const formatted = JSON.stringify(example, null, 2);
      handleInputChange(formatted);
    }
  };

  const handleExecute = async () => {
    // Parse input
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(input);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Invalid JSON');
      return;
    }

    setExecuting(true);
    setResult(null);
    setParseError(null);

    const getResult = async (): Promise<ToolExecutionResult> => {
      try {
        return await onExecute(parsedInput);
      } catch (err) {
        return {
          durationMs: 0,
          error: err instanceof Error ? err.message : 'Execution failed',
          success: false,
        };
      }
    };

    const executionResult = await getResult();
    setExecuting(false);
    setResult(executionResult);
  };

  const parseErrorId = `tool-playground-${toolId}-parse-error`;

  return (
    <div className="space-y-3" data-testid={`tool-playground-${toolId}`}>
      {/* Schema Information */}
      {schemaDisplay && (
        <>
          <ParametersSection schema={schemaDisplay} />
          <ReturnsSection returns={schemaDisplay.returns} />
        </>
      )}

      {/* Input Editor */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium">Test Input</span>
          <div className="flex gap-2">
            {schemaDisplay && (
              <Button
                data-testid="generate-example-button"
                onClick={handleGenerateExample}
                size="sm"
                variant="outline"
              >
                <Sparkles className="mr-1 h-3 w-3" />
                Example
              </Button>
            )}
            <Button
              data-testid="execute-button"
              disabled={executing}
              onClick={handleExecute}
              size="sm"
            >
              <Play className="mr-1 h-3 w-3" />
              {executing ? 'Running…' : 'Run'}
            </Button>
          </div>
        </div>
        <textarea
          aria-describedby={parseError ? parseErrorId : undefined}
          aria-invalid={Boolean(parseError)}
          aria-label="Tool input JSON"
          className="border-border bg-muted/30 h-32 w-full rounded-md border p-2 font-mono text-xs"
          data-testid="json-input"
          onChange={(e) => handleInputChange(e.target.value)}
          placeholder="{}"
          value={input}
        />
        {parseError && (
          <p className="text-destructive mt-1 text-xs" data-testid="parse-error" id={parseErrorId}>
            {parseError}
          </p>
        )}
      </div>

      {/* Result Display */}
      {result && (
        <div
          className={`rounded-md border p-2 ${
            result.success
              ? 'border-success/50 bg-success/5'
              : 'border-destructive/50 bg-destructive/5'
          }`}
          data-testid="execution-result"
        >
          <div className="mb-1 flex items-center justify-between">
            <span
              className={`text-xs font-medium ${
                result.success ? 'text-success' : 'text-destructive'
              }`}
            >
              {result.success ? 'Success' : 'Error'}
            </span>
            <span className="text-muted-foreground text-xs">{result.durationMs}ms</span>
          </div>
          <pre className="max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap">
            {result.success ? JSON.stringify(result.result, null, 2) : result.error}
          </pre>
        </div>
      )}
    </div>
  );
}
