// Mapas de status → label PT + classe de badge do DS (DESIGN_SYSTEM.md §badges).

export type BadgeClass =
  | 'neutral'
  | 'brand'
  | 'brand-soft'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'roxo'
  | 'ciano'
  | 'lima'
  | 'goiaba';

export interface BadgeDef {
  label: string;
  cls: BadgeClass;
}

export const CAMPAIGN_STATUS: Record<string, BadgeDef> = {
  draft: { label: 'Rascunho', cls: 'neutral' },
  queued: { label: 'Na fila', cls: 'info' },
  sending: { label: 'Enviando', cls: 'info' },
  paused: { label: 'Pausada', cls: 'warning' },
  completed: { label: 'Concluída', cls: 'success' },
  cancelled: { label: 'Cancelada', cls: 'neutral' },
  failed: { label: 'Falhou', cls: 'danger' },
};

export const MESSAGE_STATUS: Record<string, BadgeDef> = {
  pending: { label: 'Pendente', cls: 'neutral' },
  accepted: { label: 'Aceita', cls: 'info' },
  sent: { label: 'Enviada', cls: 'info' },
  delivered: { label: 'Entregue', cls: 'success' },
  read: { label: 'Lida', cls: 'success' },
  failed: { label: 'Falhou', cls: 'danger' },
  skipped: { label: 'Ignorada', cls: 'neutral' },
  cancelled: { label: 'Cancelada', cls: 'neutral' },
};

export const TEMPLATE_STATUS: Record<string, BadgeDef> = {
  APPROVED: { label: 'Aprovado', cls: 'success' },
  PENDING: { label: 'Em análise', cls: 'warning' },
  REJECTED: { label: 'Rejeitado', cls: 'danger' },
  PAUSED: { label: 'Pausado', cls: 'neutral' },
  DISABLED: { label: 'Desativado', cls: 'neutral' },
  UNKNOWN: { label: 'Desconhecido', cls: 'neutral' },
};

export const ENTITY_STATUS: Record<string, BadgeDef> = {
  active: { label: 'Ativo', cls: 'success' },
  inactive: { label: 'Inativo', cls: 'neutral' },
};

export const INTEGRATION_STATUS: Record<string, BadgeDef> = {
  active: { label: 'Ativa', cls: 'success' },
  inactive: { label: 'Inativa', cls: 'neutral' },
};

export const badgeFor = (map: Record<string, BadgeDef>, value: string): BadgeDef =>
  map[value] ?? { label: value, cls: 'neutral' };
