/**
 * Core CSV Export Utilities
 *
 * Shared functionality for CSV export operations to avoid code duplication
 * between basic and enhanced CSV export utilities.
 */

/**
 * Escapes a value for CSV format
 * - Wraps in quotes if contains comma, newline, or quotes
 * - Escapes quotes by doubling them
 */
export function escapeCSVValue(value: string | number | undefined | null): string {
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
 * Creates a CSV blob ready for download
 * @param csvContent The CSV content string
 * @param includeBOM Whether to include BOM for Excel compatibility (default: true)
 */
export function createCSVBlob(csvContent: string, includeBOM = true): Blob {
  // Add BOM for Excel compatibility with UTF-8 if requested
  const content = includeBOM ? `\uFEFF${csvContent}` : csvContent;
  return new Blob([content], { type: 'text/csv;charset=utf-8' });
}

/**
 * Generates a filename for the CSV export with timestamp
 * @param prefix The prefix for the filename
 * @param extension The file extension (default: 'csv')
 */
export function generateCSVFilename(prefix = 'export', extension = 'csv'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  return `${prefix}-${timestamp}.${extension}`;
}

/**
 * Format bytes to human-readable size
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format ISO date string to readable format
 */
export function formatDate(isoString: string | undefined): string {
  if (!isoString) {
    return '';
  }
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}

/**
 * Truncates content to specified character limit
 */
export function truncateContent(content: string | undefined, maxLength: number): string {
  if (!content) {
    return '';
  }
  return content.length > maxLength ? `${content.slice(0, maxLength)}...` : content;
}

/**
 * Column configuration for CSV export
 */
export interface CSVColumn<T = unknown> {
  getValue: (record: T) => string | number | undefined | null;
  header: string;
}

/**
 * Generates CSV content from an array of records
 * @param records Array of records to export
 * @param columns Column configuration
 * @returns CSV string with headers and data
 */
export function generateCSV<T>(records: T[], columns: CSVColumn<T>[]): string {
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
