/** Utilitários de CSV compartilhados (export de relatórios). */

/** Envolve o valor em aspas e escapa aspas internas (RFC 4180). */
export const escapeCsvCell = (value: unknown): string =>
  `"${String(value ?? '').replace(/"/g, '""')}"`;

/** Monta um CSV (cabeçalho + linhas) com todas as células escapadas. */
export const buildCsv = (header: string[], rows: Array<Array<unknown>>): string =>
  [header, ...rows].map((line) => line.map(escapeCsvCell).join(',')).join('\n');
