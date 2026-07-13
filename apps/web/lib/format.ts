const intFormatter = new Intl.NumberFormat('pt-BR');
const brlFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export const fmtInt = (value: number | null | undefined): string => intFormatter.format(value ?? 0);

export const fmtBRL = (value: number | null | undefined): string => brlFormatter.format(value ?? 0);

export const fmtDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};
