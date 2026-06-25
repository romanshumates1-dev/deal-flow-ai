// src/utils/export.ts

export interface CsvColumn<T> {
  key: keyof T | string;
  label: string;
  format?: (value: unknown, row: T) => string;
}

function escapeCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  // RFC 4180: if the field contains a comma, double-quote, or newline, wrap in quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportToCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: CsvColumn<T>[]
): string {
  const header = columns.map(c => escapeCell(c.label)).join(',');

  const body = rows.map(row => {
    return columns.map(col => {
      const value = row[col.key as keyof T];
      const formatted = col.format ? col.format(value, row) : value;
      return escapeCell(formatted);
    }).join(',');
  });

  return [header, ...body].join('\r\n');
}

/** Stream-safe CSV — yields chunks for large datasets */
export async function* streamToCsv<T extends Record<string, unknown>>(
  iterator: AsyncIterable<T[]>,
  columns: CsvColumn<T>[]
): AsyncGenerator<string> {
  yield columns.map(c => escapeCell(c.label)).join(',') + '\r\n';
  for await (const batch of iterator) {
    const lines = batch.map(row =>
      columns.map(col => {
        const value = row[col.key as keyof T];
        return escapeCell(col.format ? col.format(value, row) : value);
      }).join(',')
    );
    yield lines.join('\r\n') + '\r\n';
  }
}
