import type { FileRecord } from '@brainstrike/db';

/**
 * CSV Export Utilities
 *
 * Provides functionality for exporting FileRecord data to CSV format
 * with proper escaping and extensibility for future fields.
 */

/**
 * Escapes a value for CSV format
 * - Wraps in quotes if contains comma, newline, or quotes
 * - Escapes quotes by doubling them
 */
function escapeCSVValue(value: string | number | undefined | null): string {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);

  // Check if value needs escaping
  if (stringValue.includes(',') || stringValue.includes('\n') || stringValue.includes('"')) {
    // Escape quotes by doubling them
    const escaped = stringValue.replace(/"/g, '""');
    return `"${escaped}"`;
  }

  return stringValue;
}

/**
 * Truncates content to specified character limit
 */
function truncateContent(content: string | undefined, maxLength: number): string {
  if (!content) return '';
  return content.length > maxLength ? `${content.substring(0, maxLength)}...` : content;
}

/**
 * Format bytes to human-readable size
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format ISO date string to readable format
 */
function formatDate(isoString: string | undefined): string {
  if (!isoString) return '';
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}

// Define the CSV column configuration
export interface CSVColumn<T = FileRecord> {
  header: string;
  getValue: (record: T) => string | number | undefined | null;
}

/**
 * Default columns for FileRecord CSV export
 * This configuration makes it easy to add/remove/reorder columns
 */
export const DEFAULT_FILE_RECORD_COLUMNS: CSVColumn<FileRecord>[] = [
  {
    header: 'ID',
    getValue: (record) => record.id,
  },
  {
    header: 'Name',
    getValue: (record) => record.name,
  },
  {
    header: 'Path',
    getValue: (record) => record.path,
  },
  {
    header: 'Size',
    getValue: (record) => formatFileSize(record.size),
  },
  {
    header: 'Size (bytes)',
    getValue: (record) => record.size,
  },
  {
    header: 'Token Count',
    getValue: (record) => record.tokenCount || '',
  },
  {
    header: 'Content Sample (500 chars)',
    getValue: (record) => truncateContent(record.content, 500),
  },
  {
    header: 'Content Hash',
    getValue: (record) => record.contentHash || '',
  },
  {
    header: 'Created At',
    getValue: (record) => formatDate(record.createdAt),
  },
  {
    header: 'Updated At',
    getValue: (record) => formatDate(record.updatedAt),
  },
  {
    header: 'Processed At',
    getValue: (record) => formatDate(record.processedAt),
  },
];

/**
 * Generates CSV content from an array of records
 *
 * @param records - Array of records to export
 * @param columns - Column configuration (defaults to DEFAULT_FILE_RECORD_COLUMNS)
 * @returns CSV string with headers and data
 */
export function generateCSV<T = FileRecord>(
  records: T[],
  columns: CSVColumn<T>[] = DEFAULT_FILE_RECORD_COLUMNS as CSVColumn<T>[]
): string {
  // Generate header row
  const headers = columns.map((col) => escapeCSVValue(col.header)).join(',');

  // Generate data rows
  const rows = records.map((record) => {
    const values = columns.map((col) => {
      const value = col.getValue(record);
      return escapeCSVValue(value);
    });
    return values.join(',');
  });

  // Combine headers and rows
  return [headers, ...rows].join('\n');
}

/**
 * Creates a CSV blob ready for download
 */
export function createCSVBlob(csvContent: string): Blob {
  // Add BOM for Excel compatibility with UTF-8
  const Bom = '\uFEFF';
  return new Blob([Bom + csvContent], { type: 'text/csv;charset=utf-8' });
}

/**
 * Generates a filename for the CSV export with timestamp
 */
export function generateCSVFilename(prefix = 'file-records'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  return `${prefix}-${timestamp}.csv`;
}
