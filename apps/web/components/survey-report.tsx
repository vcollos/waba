'use client';

import { useCallback, useEffect, useState } from 'react';
import { useShell } from './app-shell';
import { EmptyState, ErrorBanner, Kpi, KpiSkeleton } from './ui';
import { apiDownload, apiRequest } from '../lib/api';
import { fmtDateTime, fmtInt } from '../lib/format';

interface Survey {
  id: string; name: string; clientName: string; flowName: string | null; flowId: string; executions: number;
}
interface Counts {
  audience: number; contacted: number; delivered: number; responded: number;
  unanswered: number; responseRate: number; messages: number; failedMessages: number;
}
interface SurveyReport {
  survey: Omit<Survey, 'executions'>;
  totals: Counts;
  executions: Array<Counts & { id: string; name: string; startedAt: string }>;
  unmatchedResponses: number;
  lastResponseAt: string | null;
  generatedAt: string;
}
const fmtPct = (value: number) => `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export function SurveyReportTab() {
  const { scopeClientId } = useShell();
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [selected, setSelected] = useState('');
  const [report, setReport] = useState<SurveyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const query = scopeClientId ? `?clientId=${encodeURIComponent(scopeClientId)}` : '';

  useEffect(() => {
    let active = true;
    setListLoading(true); setLoading(true); setError(null); setReport(null); setSurveys([]); setSelected('');
    void apiRequest<Survey[]>(`/reports/surveys${query}`).then((data) => {
      if (!active) return;
      const preferred = new URLSearchParams(window.location.search).get('survey');
      setSurveys(data);
      setSelected(data.find((survey) => survey.id === preferred)?.id ?? data[0]?.id ?? '');
      setListLoading(false);
      if (!data.length) setLoading(false);
    }).catch((err) => {
      if (!active) return;
      setError(err instanceof Error ? err.message : 'Falha ao carregar pesquisas.');
      setListLoading(false); setLoading(false);
    });
    return () => { active = false; };
  }, [query]);

  useEffect(() => {
    if (!selected || listLoading) return;
    let active = true;
    setLoading(true); setError(null); setReport(null);
    void apiRequest<SurveyReport>(`/reports/surveys/${encodeURIComponent(selected)}${query}`).then((data) => {
      if (!active) return;
      setReport(data); setLoading(false);
      const url = new URL(window.location.href);
      url.searchParams.set('survey', data.survey.id);
      window.history.replaceState(null, '', url);
    }).catch((err) => {
      if (!active) return;
      setError(err instanceof Error ? err.message : 'Falha ao carregar respostas.'); setLoading(false);
    });
    return () => { active = false; };
  }, [selected, query, revision, listLoading]);

  const exportCsv = useCallback(async () => {
    try {
      await apiDownload(`/reports/surveys/${encodeURIComponent(selected)}/export.csv${query}`, 'respostas-pesquisa.csv');
    } catch (err) { setError(err instanceof Error ? err.message : 'Falha ao exportar relatório.'); }
  }, [selected, query]);

  return (
    <>
      <div className="toolbar" style={{ alignItems: 'end' }}>
        <label className="field" style={{ flex: '1 1 320px', minWidth: 0 }}>
          <span className="flt-label">Pesquisa</span>
          <select aria-label="Pesquisa" className="input" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={listLoading} style={{ width: '100%', maxWidth: '100%' }}>
            {!surveys.length ? <option value="">{listLoading ? 'Carregando pesquisas…' : 'Nenhuma pesquisa disponível'}</option> : null}
            {surveys.map((survey) => <option key={survey.id} value={survey.id}>{survey.clientName} — {survey.name}</option>)}
          </select>
        </label>
        <button className="btn secondary md" onClick={() => setRevision((value) => value + 1)} disabled={loading || !selected}>Atualizar</button>
        <button className="btn secondary md" onClick={() => void exportCsv()} disabled={loading || !report}>Exportar respostas CSV</button>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      {!loading && !surveys.length && !error ? <EmptyState title="Nenhuma pesquisa com Flow neste cliente" desc="Os envios com um Flow identificado aparecem aqui, mesmo antes da primeira resposta." /> : null}
      {loading ? <div className="kpi-grid block"><KpiSkeleton count={4} /></div> : report ? (
        <>
          <div className="block">
            <div className="block-head"><span className="block-title">{report.survey.name}</span></div>
            <p className="muted" style={{ margin: '0 0 12px' }}>
              {report.survey.clientName} · {report.executions.length} envio(s), incluindo reenvios · Todo o histórico
            </p>
            <p style={{ margin: 0 }}>Cada telefone conta uma única vez no consolidado, mesmo que tenha recebido vários envios ou respondido mais de uma vez.</p>
          </div>
          <div className="kpi-grid block">
            <Kpi label="Pessoas contatadas" value={fmtInt(report.totals.contacted)} foot="Com envio confirmado ou resposta registrada" />
            <Kpi label="Pessoas que responderam" value={fmtInt(report.totals.responded)} foot="Sem duplicar entre os envios" />
            <Kpi label="Ainda sem resposta" value={fmtInt(report.totals.unanswered)} foot="Entre as pessoas contatadas" />
            <Kpi label="Taxa de resposta" value={fmtPct(report.totals.responseRate)} foot="Responderam ÷ pessoas contatadas" />
          </div>
          <div className="block">
            <div className="block-head"><span className="block-title">Envio original e reenvios</span></div>
            <div className="tbl-wrap">
              <table className="tbl dense" style={{ minWidth: 720 }}>
                <thead><tr><th>Envio</th><th>Início</th><th className="num">Pessoas contatadas</th><th className="num">Responderam neste envio</th><th className="num">Mensagens com falha</th></tr></thead>
                <tbody>{report.executions.map((execution) => <tr key={execution.id}>
                  <td>{execution.name}</td><td>{fmtDateTime(execution.startedAt)}</td>
                  <td className="num">{fmtInt(execution.contacted)}</td><td className="num">{fmtInt(execution.responded)}</td><td className="num">{fmtInt(execution.failedMessages)}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <p className="muted" style={{ margin: '12px 0 0' }}>Uma pessoa pode aparecer em mais de um envio. Use os indicadores acima para o total de pessoas únicas.</p>
          </div>
          <div className="block">
            <p style={{ margin: '0 0 8px' }}>Público total: <strong>{fmtInt(report.totals.audience)} pessoas</strong>. Destas, {fmtInt(report.totals.audience - report.totals.contacted)} ainda não têm envio confirmado nem resposta.</p>
            <p className="muted" style={{ margin: 0 }}>Respostas vinculadas aos envios deste Flow; respostas sem vínculo com uma campanha não entram. Última resposta: {fmtDateTime(report.lastResponseAt)}. Atualizado em {fmtDateTime(report.generatedAt)}.</p>
            {report.unmatchedResponses > 0 ? <p role="status">{fmtInt(report.unmatchedResponses)} resposta(s) não puderam ser associadas a uma pessoa do público e ficaram fora dos indicadores.</p> : null}
          </div>
        </>
      ) : null}
    </>
  );
}
