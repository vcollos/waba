/** Utilitários de CSV compartilhados (export de relatórios). */

/**
 * Envolve o valor em aspas e escapa aspas internas (RFC 4180) e, além disso,
 * neutraliza formula/DDE injection (CWE-1236): células que começam com um
 * caractere de fórmula (= + - @, tab ou CR) recebem um apóstrofo antes, para o
 * Excel/Sheets tratar como texto e não avaliar (ex.: nome de contato malicioso
 * `=HYPERLINK(...)`, ou telefones `+55...`).
 */
export const escapeCsvCell = (value: unknown): string => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
};

/** Monta um CSV (cabeçalho + linhas) com todas as células escapadas. */
export const buildCsv = (header: string[], rows: Array<Array<unknown>>): string =>
  [header, ...rows].map((line) => line.map(escapeCsvCell).join(',')).join('\n');
