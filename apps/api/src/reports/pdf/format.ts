/**
 * Formatação pt-BR para o PDF do relatório de campanhas (WABA-25).
 *
 * Datas de período/emissão são formatadas por fatiamento da string ISO
 * (YYYY-MM-DD), sem conversão de fuso: as fronteiras do período já vêm como
 * limites de dia em UTC (`...T00:00:00.000Z` / `...T23:59:59.999Z`) e converter
 * fuso deslocaria o dia. Datas-hora de campanha usam America/Sao_Paulo.
 */

const brlFormatter = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

const intFormatter = new Intl.NumberFormat('pt-BR');

const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** R$ 1.234,56 */
export const formatBrl = (value: number): string => brlFormatter.format(value ?? 0);

/** 1.952 (milhar com ponto) */
export const formatInt = (value: number): string => intFormatter.format(value ?? 0);

/** 90,4% (vírgula decimal; sem casa quando inteiro: 100%). */
export const formatPercent = (value: number): string => {
  const n = Number.isFinite(value) ? value : 0;
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
  return `${text}%`;
};

/** ISO -> dd/mm/aaaa (por fatiamento, fuso-agnóstico). */
export const formatDateBr = (iso: string | null | undefined): string => {
  const raw = (iso ?? '').trim();
  if (raw.length < 10) {
    return '—';
  }
  const [year, month, day] = raw.slice(0, 10).split('-');
  if (!year || !month || !day) {
    return '—';
  }
  return `${day}/${month}/${year}`;
};

/** ISO -> "dd/mm HH:mm" (America/Sao_Paulo). '—' quando ausente. */
export const formatDateTimeBr = (iso: string | null | undefined): string => {
  const raw = (iso ?? '').trim();
  if (!raw) {
    return '—';
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  // "27/07 09:09" — Intl devolve "27/07, 09:09"; removemos a vírgula.
  return dateTimeFormatter.format(date).replace(',', '');
};

/** Slug seguro p/ nome de arquivo (a-z0-9-), sem acentos. */
export const safeSlug = (value: string, fallback = 'relatorio'): string => {
  const slug = (value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
};
