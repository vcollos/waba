'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { SectionCard } from '../../components/section-card';
import { apiRequest } from '../../lib/api';

interface ResultSummary {
  totalFlowResponses: number;
  byFlow: Array<{ flowName: string; count: number }>;
}

interface FlowResponse {
  id: string;
  campaignName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  flowName?: string | null;
  templateName?: string | null;
  completedAt: string;
  responsePayload: Record<string, unknown>;
  detectedPayloadDefinitions?: Array<{
    screenId: string;
    formName?: string | null;
    actionName: string;
    payloadFields: Array<{
      key: string;
      sourceType: 'form' | 'static' | 'expression';
      sourceField?: string | null;
      expression?: string | null;
      staticValue?: string | null;
    }>;
  }>;
}

export default function ResultsPage() {
  const [summary, setSummary] = useState<ResultSummary | null>(null);
  const [responses, setResponses] = useState<FlowResponse[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      apiRequest<ResultSummary>('/results/summary'),
      apiRequest<FlowResponse[]>('/results/flow-responses'),
    ])
      .then(([summaryPayload, responsesPayload]) => {
        setSummary(summaryPayload);
        setResponses(responsesPayload);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Falha ao carregar resultados'));
  }, []);

  return (
    <AppShell title="Resultados de Flows">
      {error ? <div className="notice error">{error}</div> : null}

      <div className="grid two">
        <SectionCard
          title="Resumo"
          description="Respostas brutas recebidas dos Flows e agrupamento inicial por Flow."
        >
          <div className="stack">
            <div className="metric">
              <h3>Respostas de Flow</h3>
              <strong>{summary?.totalFlowResponses ?? 0}</strong>
              <p className="muted">Cada resposta fica preservada em JSON bruto.</p>
            </div>
            {summary?.byFlow?.length ? (
              summary.byFlow.map((item) => (
                <div key={item.flowName} className="notice">
                  <strong>{item.flowName}</strong>
                  <div className="muted">{item.count} resposta(s)</div>
                </div>
              ))
            ) : (
              <div className="muted">Nenhuma resposta recebida ainda.</div>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Armazenamento"
          description="Schema flexível: payload bruto + metadados de campanha, contato e Flow."
        >
          <div className="stack">
            <div className="notice">Sem colunas por pergunta.</div>
            <div className="notice">Exportação e flatten podem ser feitos depois.</div>
            <div className="notice">O sistema preserva o JSON original recebido.</div>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Respostas recebidas"
        description="Leitura operacional das respostas com payload bruto para auditoria e exportação."
      >
        <div className="stack">
          {responses.length ? (
            responses.map((response) => (
              <div key={response.id} className="card">
                <div className="stack">
                  <div>
                    <strong>{response.flowName ?? 'Flow não identificado'}</strong>
                    <div className="muted">
                      {response.campaignName ?? 'Sem campanha'} /{' '}
                      {response.contactName ?? response.contactPhone ?? 'Contato não identificado'}
                    </div>
                    <div className="muted">
                      Recebido em {new Date(response.completedAt).toLocaleString('pt-BR')}
                    </div>
                  </div>

                  {response.detectedPayloadDefinitions?.length ? (
                    <div className="stack">
                      <span className="tag success">Schema detectado</span>
                      {response.detectedPayloadDefinitions.map((definition) => (
                        <div
                          key={`${response.id}:${definition.screenId}:${definition.actionName}`}
                          className="notice"
                        >
                          <div className="muted">
                            Tela {definition.screenId}
                            {definition.formName ? ` / formulário ${definition.formName}` : ''}
                          </div>
                          <div className="muted">
                            {definition.payloadFields
                              .map((field) => {
                                if (field.sourceType === 'form') {
                                  return `${field.key} <= form.${field.sourceField}`;
                                }
                                if (field.sourceType === 'expression') {
                                  return `${field.key} <= ${field.expression}`;
                                }
                                return `${field.key} = ${field.staticValue ?? ''}`;
                              })
                              .join(' | ')}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <pre className="json-block">
                    {JSON.stringify(response.responsePayload, null, 2)}
                  </pre>
                </div>
              </div>
            ))
          ) : (
            <div className="muted">Nenhuma resposta de Flow foi capturada ainda.</div>
          )}
        </div>
      </SectionCard>
    </AppShell>
  );
}
