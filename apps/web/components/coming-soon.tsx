'use client';

import { AppShell } from './app-shell';

/**
 * Placeholder de andaime para telas previstas no DESIGN.md ainda não
 * implementadas neste PR. Não é UI de produto — apenas mantém a navegação
 * coerente enquanto as telas são entregues em fatias verticais seguintes.
 */
export function ComingSoon({ title }: { title: string }) {
  return (
    <AppShell title={title}>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">{title}</h1>
        </div>
      </div>
      <div className="empty">
        <div className="empty-ico">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
            <circle cx="12" cy="12" r="4" />
          </svg>
        </div>
        <div className="empty-title">Tela em construção</div>
        <div className="empty-desc">
          Esta área será implementada na próxima etapa da migração.
        </div>
      </div>
    </AppShell>
  );
}
