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

export interface ImportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  fileName: string;
  listName: string;
  totalRows: number;
  processedRows: number;
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
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [defaults, setDefaults] = useState({ clientName: '', category: '', status: 'active' as RecordStatus });
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const readColumns = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Selecione um arquivo CSV.');
      return;
    }
    if (!listName.trim()) {
      setError('Informe o nome da lista.');
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
      setStep(2);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao ler o CSV.');
    } finally {
      setBusy(false);
    }
  };

  const startImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Arquivo perdido. Recomece o assistente.');
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
          if (next.status === 'completed') onDone(next);
          if (next.status === 'failed') {
            setError(next.error ?? 'Importação falhou.');
            setBusy(false);
          }
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [job, onDone]);

  const steps = ['Arquivo', 'Mapeamento', 'Confirmação'];

  return (
    <Modal
      title={title}
      width="xwide"
      onClose={onClose}
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
            <button className="btn primary md" onClick={() => setStep(3)}>
              Revisar
            </button>
          ) : null}
          {step === 3 ? (
            <button className="btn primary md" onClick={startImport} disabled={busy || !!job}>
              {job ? 'Importando…' : busy ? 'Iniciando…' : 'Confirmar importação'}
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
            <label>
              Nome da lista <span className="req">*</span>
            </label>
            <input className="input" value={listName} onChange={(e) => setListName(e.target.value)} />
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
        </>
      ) : null}

      {step === 3 && preview ? (
        <>
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
          {job ? (
            <div className="toast" style={{ marginTop: 14 }}>
              Processando {fmtInt(job.processedRows)} / {fmtInt(job.totalRows)} — {fileName}
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
