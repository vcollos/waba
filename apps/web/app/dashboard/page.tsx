'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { SectionCard } from '../../components/section-card';
import { apiRequest } from '../../lib/api';

interface Summary {
  contacts: number;
  optedOutContacts: number;
  lists: number;
  integrations: number;
  templates: number;
  flows: number;
  campaigns: number;
  messages: number;
  flowResponses: number;
  delivered: number;
  read: number;
  failed: number;
  recentCampaigns: Array<{ id: string; name: string; status: string; createdAt: string }>;
}

export default function DashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void apiRequest<Summary>('/dashboard/summary')
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : 'Falha ao carregar'));
  }, []);

  return (
    <AppShell title="Dashboard operacional">
      {error ? <div className="notice error">{error}</div> : null}

      <div className="grid four">
        <div className="metric">
          <h3>Contatos</h3>
          <strong>{summary?.contacts ?? 0}</strong>
          <p className="muted">{summary?.optedOutContacts ?? 0} com opt-out</p>
        </div>
        <div className="metric">
          <h3>Biblioteca</h3>
          <strong>{summary?.templates ?? 0}</strong>
          <p className="muted">{summary?.flows ?? 0} flows em cache</p>
        </div>
        <div className="metric">
          <h3>Mensagens</h3>
          <strong>{summary?.messages ?? 0}</strong>
          <p className="muted">
            {summary?.delivered ?? 0} entregues / {summary?.read ?? 0} lidas /{' '}
            {summary?.failed ?? 0} falhas
          </p>
        </div>
        <div className="metric">
          <h3>Respostas</h3>
          <strong>{summary?.flowResponses ?? 0}</strong>
          <p className="muted">Respostas de Flow recebidas e armazenadas</p>
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 18 }}>
        <SectionCard
          title="Estado do piloto"
          description="Leitura rápida do ambiente operacional local."
        >
          <div className="stack">
            <div className="notice">Integrações salvas: {summary?.integrations ?? 0}</div>
            <div className="notice">Listas disponíveis: {summary?.lists ?? 0}</div>
            <div className="notice">Campanhas registradas: {summary?.campaigns ?? 0}</div>
          </div>
        </SectionCard>

        <SectionCard
          title="Campanhas recentes"
          description="Últimas execuções ou rascunhos registrados no piloto."
        >
          <div className="stack">
            {summary?.recentCampaigns?.length ? (
              summary.recentCampaigns.map((campaign) => (
                <div key={campaign.id} className="notice">
                  <strong>{campaign.name}</strong>
                  <div className="muted">
                    {campaign.status} em {new Date(campaign.createdAt).toLocaleString('pt-BR')}
                  </div>
                </div>
              ))
            ) : (
              <div className="muted">Nenhuma campanha criada ainda.</div>
            )}
          </div>
        </SectionCard>
      </div>
    </AppShell>
  );
}
