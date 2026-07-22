/**
 * Utilitários de CSV do frontend (exportação de contatos).
 *
 * Espelha `apps/api/src/common/csv.ts`: além do escape RFC 4180, neutraliza
 * formula/DDE injection (CWE-1236) — células que começam com um caractere de
 * fórmula (= + - @, tab ou CR) recebem um apóstrofo antes, para o Excel/Sheets
 * tratarem como texto e não avaliarem (ex.: nome `=HYPERLINK(...)`, telefone
 * `+55...`).
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
  [header, ...rows].map((line) => line.map(escapeCsvCell).join(',')).join('\r\n');

/**
 * Dispara o download de um CSV no navegador. Prefixa BOM (﻿) para o Excel
 * reconhecer UTF-8 e não corromper acentos.
 */
export function downloadCsv(fileName: string, header: string[], rows: Array<Array<unknown>>) {
  const csv = buildCsv(header, rows);
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
