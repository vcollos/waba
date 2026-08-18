'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui';
import { apiRequest } from '../lib/api';
import { fmtInt } from '../lib/format';

type RecordStatus = 'active' | 'inactive';

interface ImportPreviewField {
  key: string;
  label: string;
  required: boolean;
}

export interface ImportPreview {
  headers: string[];
  totalRows: number;
  sampleRows: Array<Record<string, string>>;
  recommendedMapping: Record<string, string | null>;
  availableFields: ImportPreviewField[];
}

export interface ImportResult {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  skippedRows?: number;
}

export interface UpdateSummary {
  updated: number;
  created: number;
  unchanged: number;
  conflicts: number;
  invalid: number;
}

/** Projeção (dry-run) da importação, antes de confirmar. */
export interface ImportPlan {
  mode: 'insert' | 'update';
  total: number;
  updated?: number;
  created?: number;
  unchanged?: number;
  conflicts?: number;
  invalid?: number;
}

export interface ImportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  mode: 'insert' | 'update';
  fileName: string;
  listName: string;
  totalRows: number;
  processedRows: number;
  importRecord?: ImportResult | null;
  updateSummary?: UpdateSummary | null;
  error?: string | null;
}

/** Colunas do template CSV oferecido para download. */
export const CSV_TEMPLATE_HEADERS = ['nome_completo', 'telefone', 'email', 'categoria'];

/** Dispara o download de um template CSV com cabeçalho e uma linha de exemplo. */
export function downloadCsvTemplate(fileName = 'modelo-lista-contatos.csv') {
  const sample = ['Maria da Silva', '+5511999998888', 'maria@exemplo.com', 'Titular'];
  const csv = `${CSV_TEMPLATE_HEADERS.join(',')}\n${sample.join(',')}\n`;
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

/**
 * Assistente de importação de contatos por CSV em 3 passos (arquivo →
 * mapeamento → confirmação). Cria uma nova lista com os contatos do arquivo,
 * escopada ao tenant ativo pelo backend. Reutilizado nas telas Contatos e Listas.
 */
export function CsvImportModal({
  title = 'Importar contatos (CSV)',
  clientId,
  onClose,
  onDone,
}: {
  title?: string;
  clientId?: string | null;
  onClose: () => void;
  onDone: (job: ImportJob) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(1);
  const [listName, setListName] = useState('');
  const [fileName, setFileName] = useState('');
  // Guardamos o File em estado: o <input type="file"> só existe no passo 1 e é
  // desmontado ao avançar, então não dá para relê-lo do ref na confirmação.
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [defaults, setDefaults] = useState({ clientName: '', category: '', status: 'active' as RecordStatus });
  // Contato já existente (mesmo telefone no tenant): sobrescrever com os dados do
  // arquivo (mais novos como principais) ou preservar e apenas vincular à lista.
  const [overwriteExisting, setOverwriteExisting] = useState(true);
  // Congela a flag usada no job em execução — o rótulo do resultado deve refletir
  // o que foi enviado ao servidor, não o estado atual do checkbox.
  const [jobOverwrite, setJobOverwrite] = useState(true);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Modo atualização em massa: ligado quando a coluna "ID do cadastro" está
  // mapeada. Casa por ID (estável mesmo com troca de telefone) e não cria lista.
  const updateMode = Boolean(mapping.id);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);

  const readColumns = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Selecione um arquivo CSV.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const result = await apiRequest<ImportPreview>('/contacts/imports/csv/preview', {
        method: 'POST',
        body: formData,
      });
      setPreview(result);
      setMapping(result.recommendedMapping);
      setFileName(file.name);
      setCsvFile(file);
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao ler o CSV.');
    } finally {
      setBusy(false);
    }
  };

  // Projeção (dry-run) da atualização em massa: quantos contatos seriam
  // alterados/criados/mantidos, para confirmar antes de aplicar.
  const loadPlan = async () => {
    const file = csvFile ?? fileRef.current?.files?.[0];
    if (!file) return;
    setPlanBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (clientId) formData.append('clientId', clientId);
      formData.append('mapping', JSON.stringify(mapping));
      const result = await apiRequest<ImportPlan>('/contacts/imports/csv/plan', {
        method: 'POST',
        body: formData,
      });
      setPlan(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao projetar a atualização.');
    } finally {
      setPlanBusy(false);
    }
  };

  const goToReview = () => {
    setPlan(null);
    setStep(3);
    if (updateMode) void loadPlan();
  };

  const startImport = async () => {
    const file = csvFile ?? fileRef.current?.files?.[0];
    if (!file) {
      setError('Arquivo perdido. Recomece o assistente.');
      return;
    }
    if (!updateMode && !listName.trim()) {
      setError('Informe o nome da lista.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('listName', listName);
      if (clientId) formData.append('clientId', clientId);
      formData.append('mapping', JSON.stringify(mapping));
      formData.append('defaults', JSON.stringify(defaults));
      formData.append('overwriteExisting', String(overwriteExisting));
      setJobOverwrite(overwriteExisting);
      const started = await apiRequest<ImportJob>('/contacts/imports/csv', {
        method: 'POST',
        body: formData,
      });
      setJob(started);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao iniciar importação.');
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const timer = window.setInterval(() => {
      void apiRequest<ImportJob>(`/contacts/imports/csv/jobs/${job.id}`)
        .then((next) => {
          setJob(next);
          // Ao concluir, mantém o modal aberto para exibir o resultado; o fechamento
          // e o refresh da lista acontecem quando o usuário clica em "Concluir".
          if (next.status === 'completed') setBusy(false);
          if (next.status === 'failed') {
            setError(next.error ?? 'Importação falhou.');
            setBusy(false);
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job]);

  const steps = ['Arquivo', 'Mapeamento', 'Confirmação'];

  // Fechar pelo X após concluir equivale a "Concluir": garante o refresh da
  // lista na tela que abriu o modal.
  const handleClose = () => {
    if (job?.status === 'completed') {
      onDone(job);
      return;
    }
    onClose();
  };

  return (
    <Modal
      title={title}
      width="xwide"
      onClose={handleClose}
      footer={
        <>
          {error ? (
            <span className="left" style={{ color: 'var(--danger)', fontSize: 13 }}>
              {error}
            </span>
          ) : null}
          {step > 1 ? (
            <button className="btn tertiary md" onClick={() => setStep(step - 1)} disabled={busy || !!job}>
              Voltar
            </button>
          ) : null}
          {step === 1 ? (
            <button className="btn primary md" onClick={readColumns} disabled={busy}>
              {busy ? 'Lendo…' : 'Ler colunas'}
            </button>
          ) : null}
          {step === 2 ? (
            <button className="btn primary md" onClick={goToReview}>
              Revisar
            </button>
          ) : null}
          {step === 3 && job?.status === 'completed' ? (
            <button className="btn primary md" onClick={() => onDone(job)}>
              Concluir
            </button>
          ) : step === 3 && job?.status === 'failed' ? (
            <button
              className="btn primary md"
              disabled={busy}
              onClick={() => {
                setJob(null);
                setError(null);
                void startImport();
              }}
            >
              Tentar novamente
            </button>
          ) : step === 3 ? (
            <button
              className="btn primary md"
              onClick={startImport}
              disabled={busy || !!job || (updateMode && (planBusy || !plan))}
            >
              {job
                ? updateMode
                  ? 'Atualizando…'
                  : 'Importando…'
                : busy
                  ? 'Iniciando…'
                  : updateMode
                    ? `Sim, atualizar ${fmtInt(plan?.updated ?? 0)} contato(s)`
                    : 'Confirmar importação'}
            </button>
          ) : null}
        </>
      }
    >
      <div className="stepper" style={{ marginBottom: 22 }}>
        {steps.map((label, index) => {
          const n = index + 1;
          const cls = step === n ? 'on' : step > n ? 'done' : '';
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center' }}>
              <div className={`step ${cls}`}>
                <span className="step-dot">{step > n ? '✓' : n}</span>
                <span className="step-name">{label}</span>
              </div>
              {n < steps.length ? <span className={`step-bar${step > n ? ' done' : ''}`} /> : null}
            </div>
          );
        })}
      </div>

      {step === 1 ? (
        <div className="form-grid">
          <div className="field col-2">
            <label>Nome da lista</label>
            <input className="input" value={listName} onChange={(e) => setListName(e.target.value)} />
            <span className="cell-sub" style={{ fontSize: 12 }}>
              Usado ao importar contatos novos. Se o CSV tiver a coluna <strong>id</strong>, o
              assistente entra em modo de atualização em massa e nenhuma lista é criada.
            </span>
          </div>
          <div className="field col-2">
            <label>
              Arquivo CSV <span className="req">*</span>
            </label>
            <input ref={fileRef} className="input" type="file" accept=".csv,text/csv" style={{ paddingTop: 7 }} />
          </div>
        </div>
      ) : null}

      {step === 2 && preview ? (
        <>
          {updateMode ? (
            <div className="toast" style={{ marginBottom: 14 }}>
              <strong>Modo atualização em massa.</strong> A coluna <strong>ID do cadastro</strong> está
              mapeada: os contatos serão casados por ID (mesmo que o telefone tenha mudado) e
              atualizados. Linhas com ID em branco ou inexistente viram contatos novos. Nenhuma lista é
              criada.
            </div>
          ) : null}
          <div className="block-title" style={{ marginBottom: 12 }}>
            Mapeamento de colunas
          </div>
          <div className="form-grid">
            {preview.availableFields.map((field) => (
              <div key={field.key} className="field">
                <label>
                  {field.label} {field.required ? <span className="req">*</span> : null}
                </label>
                <select
                  className="input"
                  value={mapping[field.key] ?? ''}
                  onChange={(e) => setMapping((c) => ({ ...c, [field.key]: e.target.value || null }))}
                >
                  <option value="">Não mapear</option>
                  {preview.headers.map((header) => (
                    <option key={header} value={header}>
                      {header}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {!updateMode ? (
            <>
              <div className="block-title" style={{ margin: '20px 0 12px' }}>
                Valores padrão
              </div>
              <div className="form-grid">
                <div className="field">
                  <label>Cliente legado</label>
                  <input
                    className="input"
                    value={defaults.clientName}
                    onChange={(e) => setDefaults((c) => ({ ...c, clientName: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>Categoria</label>
                  <input
                    className="input"
                    value={defaults.category}
                    onChange={(e) => setDefaults((c) => ({ ...c, category: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label>Status</label>
                  <select
                    className="input"
                    value={defaults.status}
                    onChange={(e) => setDefaults((c) => ({ ...c, status: e.target.value as RecordStatus }))}
                  >
                    <option value="active">Ativo</option>
                    <option value="inactive">Inativo</option>
                  </select>
                </div>
              </div>
              <label
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 16, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={overwriteExisting}
                  onChange={(e) => setOverwriteExisting(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <strong>Atualizar contatos já existentes com os dados do arquivo</strong>
                  <span className="cell-sub" style={{ display: 'block', fontSize: 12 }}>
                    Quando o telefone já existir, usa os dados do arquivo (mais novos) como principais.
                    Desmarque para preservar o contato atual e apenas vinculá-lo a esta lista.
                  </span>
                </span>
              </label>
            </>
          ) : null}
        </>
      ) : null}

      {step === 3 && preview ? (
        <>
          {updateMode ? (
            <div style={{ marginBottom: 18 }}>
              {planBusy || !plan ? (
                <div className="toast">Analisando alterações…</div>
              ) : (
                <>
                  <div
                    className="toast"
                    style={{ marginBottom: 12, fontSize: 15 }}
                  >
                    Deseja atualizar <strong>{fmtInt(plan.updated ?? 0)}</strong> contato(s) alterado(s)?
                  </div>
                  <div className="kpi-grid">
                    <div className="kpi">
                      <span className="kpi-label">A atualizar</span>
                      <span className="kpi-val">{fmtInt(plan.updated ?? 0)}</span>
                    </div>
                    <div className="kpi">
                      <span className="kpi-label">Novos</span>
                      <span className="kpi-val">{fmtInt(plan.created ?? 0)}</span>
                    </div>
                    <div className="kpi">
                      <span className="kpi-label">Sem mudança</span>
                      <span className="kpi-val">{fmtInt(plan.unchanged ?? 0)}</span>
                    </div>
                    <div className="kpi">
                      <span className="kpi-label">Total no arquivo</span>
                      <span className="kpi-val">{fmtInt(plan.total)}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="kpi-grid k3" style={{ marginBottom: 18 }}>
              <div className="kpi">
                <span className="kpi-label">Total de linhas</span>
                <span className="kpi-val">{fmtInt(preview.totalRows)}</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Lista</span>
                <span className="kpi-val sm">{listName}</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Campos mapeados</span>
                <span className="kpi-val">{fmtInt(Object.values(mapping).filter(Boolean).length)}</span>
              </div>
            </div>
          )}
          {preview.totalRows > 50000 ? (
            <div className="toast warning" style={{ marginBottom: 14 }}>
              Lote grande: a importação roda em segundo plano e pode levar alguns minutos.
            </div>
          ) : null}
          <div className="block-title" style={{ marginBottom: 10 }}>
            Amostra
          </div>
          <div className="tbl-wrap">
            <table className="tbl dense">
              <thead>
                <tr>
                  {preview.headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sampleRows.slice(0, 5).map((row, i) => (
                  <tr key={i}>
                    {preview.headers.map((h) => (
                      <td key={h} className="cell-sub">
                        {row[h] || '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {job && job.status !== 'completed' ? (
            <div className="toast" style={{ marginTop: 14 }}>
              Processando {fmtInt(job.processedRows)} / {fmtInt(job.totalRows)} — {fileName}
            </div>
          ) : null}
          {job?.status === 'completed' && job.importRecord ? (
            <>
              <div className="block-title" style={{ margin: '18px 0 10px' }}>
                Resultado da importação
              </div>
              <div className="kpi-grid">
                <div className="kpi">
                  <span className="kpi-label">Novos contatos</span>
                  <span className="kpi-val">
                    {fmtInt(
                      Math.max(
                        0,
                        job.importRecord.totalRows -
                          job.importRecord.duplicateRows -
                          (job.importRecord.skippedRows ?? 0),
                      ),
                    )}
                  </span>
                </div>
                <div className="kpi">
                  <span className="kpi-label">{jobOverwrite ? 'Atualizados' : 'Já existentes'}</span>
                  <span className="kpi-val">{fmtInt(job.importRecord.duplicateRows)}</span>
                </div>
                <div className="kpi">
                  <span className="kpi-label">Válidos</span>
                  <span className="kpi-val">{fmtInt(job.importRecord.validRows)}</span>
                </div>
                <div className="kpi">
                  <span className="kpi-label">Inválidos</span>
                  <span className="kpi-val">{fmtInt(job.importRecord.invalidRows)}</span>
                </div>
              </div>
              {job.importRecord.invalidRows > 0 ? (
                <div className="toast warning" style={{ marginTop: 12 }}>
                  {fmtInt(job.importRecord.invalidRows)} linha(s) com telefone inválido foram importadas como
                  inválidas e não recebem envios até correção.
                </div>
              ) : null}
              {(job.importRecord.skippedRows ?? 0) > 0 ? (
                <div className="toast warning" style={{ marginTop: 12 }}>
                  {fmtInt(job.importRecord.skippedRows ?? 0)} linha(s) foram ignoradas por não terem
                  telefone utilizável (célula vazia ou sem nenhum dígito). Corrija o telefone dessas
                  linhas no arquivo e importe de novo.
                </div>
              ) : null}
            </>
          ) : null}
          {job?.status === 'completed' && job.updateSummary ? (
            <>
              <div className="block-title" style={{ margin: '18px 0 10px' }}>
                Resultado da atualização
              </div>
              <div className="kpi-grid">
                <div className="kpi">
                  <span className="kpi-label">Atualizados</span>
                  <span className="kpi-val">{fmtInt(job.updateSummary.updated)}</span>
                </div>
                <div className="kpi">
                  <span className="kpi-label">Novos</span>
                  <span className="kpi-val">{fmtInt(job.updateSummary.created)}</span>
                </div>
                <div className="kpi">
                  <span className="kpi-label">Sem mudança</span>
                  <span className="kpi-val">{fmtInt(job.updateSummary.unchanged)}</span>
                </div>
                <div className="kpi">
                  <span className="kpi-label">Inválidos</span>
                  <span className="kpi-val">{fmtInt(job.updateSummary.invalid)}</span>
                </div>
              </div>
              {job.updateSummary.conflicts > 0 ? (
                <div className="toast warning" style={{ marginTop: 12 }}>
                  {fmtInt(job.updateSummary.conflicts)} linha(s) puladas por conflito de telefone (número já
                  usado por outro contato do mesmo cliente).
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
