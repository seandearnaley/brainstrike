import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import { defaultCollator } from '@brainstrike/utils/collator';
import type { LogRecord } from '@brainstrike/utils/logger';
import { useMemo, useState } from 'react';
import { getLogRecordCode, getLogRecordSource } from './log-diagnostic-metadata';

export const ALL_SOURCES_VALUE = '__all_sources__';
export const ALL_CODES_VALUE = '__all_codes__';
export const NO_CODE_VALUE = '__no_code__';
const END_OF_MINUTE_OFFSET_MS = 60_000 - 1;

interface LogDiagnosticFiltersProps {
  codeFilter: string;
  onCodeChange: (value: string) => void;
  onSourceChange: (value: string) => void;
  onTimeEndChange: (value: number | null) => void;
  onTimeStartChange: (value: number | null) => void;
  records: readonly LogRecord[];
  sourceFilter: string;
  timeEnd: number | null;
  timeStart: number | null;
}

function toLocalDateTimeValue(timestamp: number | null): string {
  if (timestamp === null) {
    return '';
  }
  const date = new Date(timestamp);
  const localTimestamp = timestamp - date.getTimezoneOffset() * 60_000;
  return new Date(localTimestamp).toISOString().slice(0, 16);
}

function parseLocalDateTime(value: string, boundary: 'start' | 'end'): number | null {
  if (value.length === 0) {
    return null;
  }
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid local diagnostic time: ${value}`);
  }
  return boundary === 'end' ? timestamp + END_OF_MINUTE_OFFSET_MS : timestamp;
}

export function LogDiagnosticFilters({
  records,
  sourceFilter,
  onSourceChange,
  codeFilter,
  onCodeChange,
  timeStart,
  onTimeStartChange,
  timeEnd,
  onTimeEndChange,
}: LogDiagnosticFiltersProps) {
  const [invalidTimeBoundary, setInvalidTimeBoundary] = useState<'start' | 'end' | null>(null);
  const sourceOptions = useMemo(
    () =>
      Array.from(new Set(records.map(getLogRecordSource))).sort((left, right) =>
        defaultCollator.compare(left, right)
      ),
    [records]
  );
  const codeOptions = useMemo(() => {
    const codes = new Set<string>();
    for (const record of records) {
      const code = getLogRecordCode(record);
      if (code) {
        codes.add(code);
      }
    }
    return Array.from(codes).sort((left, right) => defaultCollator.compare(left, right));
  }, [records]);
  const invalidRange = timeStart !== null && timeEnd !== null && timeStart > timeEnd;
  const errorMessage =
    invalidTimeBoundary === null
      ? invalidRange
        ? 'From time must be before To time.'
        : null
      : `${invalidTimeBoundary === 'start' ? 'From' : 'To'} time is invalid.`;

  const handleTimeChange = (
    value: string,
    boundary: 'start' | 'end',
    onChange: (value: number | null) => void
  ): void => {
    try {
      onChange(parseLocalDateTime(value, boundary));
      setInvalidTimeBoundary(null);
    } catch {
      setInvalidTimeBoundary(boundary);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="log-diagnostic-filters">
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs" htmlFor="log-viewer-source-filter">
          Source
        </Label>
        <Select onValueChange={onSourceChange} value={sourceFilter}>
          <SelectTrigger
            aria-label="Source"
            className="h-8 w-[170px] border-border/50 bg-muted/40"
            id="log-viewer-source-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SOURCES_VALUE}>All sources</SelectItem>
            {sourceOptions.map((source) => (
              <SelectItem key={source} value={source}>
                {source}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs" htmlFor="log-viewer-code-filter">
          Code
        </Label>
        <Select onValueChange={onCodeChange} value={codeFilter}>
          <SelectTrigger
            aria-label="Code"
            className="h-8 w-[170px] border-border/50 bg-muted/40"
            id="log-viewer-code-filter"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CODES_VALUE}>All codes</SelectItem>
            <SelectItem value={NO_CODE_VALUE}>No code</SelectItem>
            {codeOptions.map((code) => (
              <SelectItem key={code} value={code}>
                {code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs" htmlFor="log-viewer-time-start">
          From
        </Label>
        <Input
          aria-invalid={invalidRange || invalidTimeBoundary === 'start'}
          aria-label="From time"
          className="h-8 w-[190px] border-border/50 bg-muted/40 text-xs"
          id="log-viewer-time-start"
          onChange={(event) =>
            handleTimeChange(event.currentTarget.value, 'start', onTimeStartChange)
          }
          type="datetime-local"
          value={toLocalDateTimeValue(timeStart)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs" htmlFor="log-viewer-time-end">
          To
        </Label>
        <Input
          aria-invalid={invalidRange || invalidTimeBoundary === 'end'}
          aria-label="To time"
          className="h-8 w-[190px] border-border/50 bg-muted/40 text-xs"
          id="log-viewer-time-end"
          onChange={(event) => handleTimeChange(event.currentTarget.value, 'end', onTimeEndChange)}
          type="datetime-local"
          value={toLocalDateTimeValue(timeEnd)}
        />
      </div>

      {errorMessage ? (
        <span className="pb-1 text-destructive text-xs" role="alert">
          {errorMessage}
        </span>
      ) : null}
    </div>
  );
}
