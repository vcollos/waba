'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import {
  Badge,
  BadgeText,
  EmptyState,
  ErrorBanner,
  Modal,
  SkeletonRows,
  ToastHost,
  useToasts,
} from '../../components/ui';
import { apiRequest } from '../../lib/api';
import { ENTITY_STATUS, badgeFor } from '../../lib/badges';
import { fmtDateTime, fmtInt } from '../../lib/format';

type RecordStatus = 'active' | 'inactive';

interface Contact {
  id: string;
  clientName?: string | null;
  firstName: string;
  lastName?: string | null;
  name: string;
  category?: string | null;
  recordStatus: RecordStatus;
  phoneE164: string;
  phoneRaw: string;
  email?: string | null;
  externalRef?: string | null;
  importedAt?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  isValid: boolean;
  isOptedOut: boolean;
  validationError?: string | null;
  listNames: string[];
}

interface ListItem {
  id: string;
  name: string;
  totalMembers: number;
  eligibleMembers: number;
}

interface PaginatedContactsResponse {
  items: Contact[];
  total: number;
  limit: number;
  offset: number;
}

interface ImportPreviewField {
  key: string;
  label: string;
  required: boolean;
}

interface ImportPreview {
  headers: string[];
  totalRows: number;
  sampleRows: Array<Record<string, string>>;
  recommendedMapping: Record<string, string | null>;
  availableFields: ImportPreviewField[];
}

interface ImportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  fileName: string;
  listName: string;
  totalRows: number;
  processedRows: number;
  error?: string | null;
}

const PAGE_SIZE = 50;

const emptyToNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const stripDefaultCountryCode = (value: string): string => {
  const digits = value.replace(/\D+/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return digits.slice(2);
  }
  return digits || value;
};

export default function ContactsPage() {
  return (
    <AppShell title="Contatos">
      <ContactsContent />
    </AppShell>
  );
}

function ContactsContent() {
  const { toasts, push } = useToasts();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [lists, setLists] = useState<ListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // filtros (client-side sobre a página carregada)
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [valid, setValid] = useState('');
  const [optOut, setOptOut] = useState('');
  const [listFilter, setListFilter] = useState('');

  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(
    (nextOffset = 0) => {
      setLoading(true);
      setError(null);
      Promise.all([
        apiRequest<PaginatedContactsResponse>(`/contacts?limit=${PAGE_SIZE}&offset=${nextOffset}`),
        apiRequest<ListItem[]>('/lists'),
      ])
        .then(([page, listsPayload]) => {
          setContacts(page.items);
          setTotal(page.total);
          setOffset(page.offset);
          setLists(listsPayload);
          setSelected((current) => current.filter((id) => page.items.some((c) => c.id === id)));
          setLoading(false);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : 'Falha ao carregar contatos.');
          setLoading(false);
        });
    },
    [],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  const categories = useMemo(
    () => Array.from(new Set(contacts.map((c) => c.category).filter(Boolean))) as string[],
    [contacts],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return contacts.filter((c) => {
      if (category && c.category !== category) return false;
      if (status && c.recordStatus !== status) return false;
      if (valid === 'valid' && !c.isValid) return false;
      if (valid === 'invalid' && c.isValid) return false;
      if (optOut === 'out' && !c.isOptedOut) return false;
      if (optOut === 'in' && c.isOptedOut) return false;
      if (listFilter && !c.listNames.includes(listFilter)) return false;
      if (term) {
        const hay = `${c.name} ${c.phoneE164} ${c.email ?? ''} ${c.clientName ?? ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [contacts, search, category, status, valid, optOut, listFilter]);

  const runAction = async (fn: () => Promise<void>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      if (success) push('success', success);
    } catch (err) {
      push('danger', err instanceof Error ? err.message : 'Falha na operação.');
    } finally {
      setBusy(false);
    }
  };

  const toggleOpt = (contact: Contact) =>
    runAction(async () => {
      await apiRequest(`/contacts/${contact.id}/${contact.isOptedOut ? 'opt-in' : 'opt-out'}`, {
        method: 'POST',
      });
      load(offset);
    }, contact.isOptedOut ? 'Contato liberado.' : 'Opt-out aplicado.');

  const removeContact = (contact: Contact) =>
    runAction(async () => {
      await apiRequest(`/contacts/${contact.id}`, { method: 'DELETE' });
      load(offset);
    }, 'Contato removido.');

  const runBulk = (action: string, extra: Record<string, unknown> = {}) =>
    runAction(async () => {
      await apiRequest('/contacts/bulk', {
        method: 'POST',
        body: JSON.stringify({ action, contactIds: selected, ...extra }),
      });
      setSelected([]);
      load(offset);
    }, 'Ação em massa concluída.');

  const allChecked = filtered.length > 0 && filtered.every((c) => selected.includes(c.id));
  const toggleAll = () =>
    setSelected(allChecked ? [] : filtered.map((c) => c.id));
  const toggleOne = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Contatos</h1>
          <p className="op-sub">Base operacional de destinatários do WhatsApp.</p>
        </div>
        <div className="op-actions">
          <button className="btn secondary md" onClick={() => setImporting(true)}>
            Importar CSV
          </button>
          <button className="btn primary md" onClick={() => setEditing('new')}>
            Novo contato
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={() => load(offset)} /> : null}

      {selected.length > 0 ? (
        <div className="bulkbar">
          <strong>{selected.length}</strong> selecionado(s)
          <div className="toolbar-spacer" />
          <button className="btn secondary sm" disabled={busy} onClick={() => runBulk('activate')}>
            Ativar
          </button>
          <button className="btn secondary sm" disabled={busy} onClick={() => runBulk('deactivate')}>
            Inativar
          </button>
          <button className="btn secondary sm" disabled={busy} onClick={() => runBulk('opt_out')}>
            Opt-out
          </button>
          <button className="btn secondary sm" disabled={busy} onClick={() => runBulk('opt_in')}>
            Opt-in
          </button>
          <button className="btn secondary sm" disabled={busy} onClick={() => runBulk('delete')}>
            Excluir
          </button>
          <button className="btn tertiary sm" onClick={() => setSelected([])}>
            Limpar
          </button>
        </div>
      ) : null}

      <div className="toolbar">
        <div className="tb-search">
          <SearchIcon />
          <input
            placeholder="Buscar nome, WhatsApp, e-mail"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select className="flt" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Categoria</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="flt" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Status</option>
          <option value="active">Ativo</option>
          <option value="inactive">Inativo</option>
        </select>
        <select className="flt" value={valid} onChange={(e) => setValid(e.target.value)}>
          <option value="">Válido</option>
          <option value="valid">Válidos</option>
          <option value="invalid">Inválidos</option>
        </select>
        <select className="flt" value={optOut} onChange={(e) => setOptOut(e.target.value)}>
          <option value="">Opt-out</option>
          <option value="out">Com opt-out</option>
          <option value="in">Sem opt-out</option>
        </select>
        <select className="flt" value={listFilter} onChange={(e) => setListFilter(e.target.value)}>
          <option value="">Lista</option>
          {lists.map((l) => (
            <option key={l.id} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <span
                  className={`cb${allChecked ? ' on' : ''}`}
                  role="checkbox"
                  aria-checked={allChecked}
                  onClick={toggleAll}
                />
              </th>
              <th>Nome completo</th>
              <th>WhatsApp</th>
              <th>E-mail</th>
              <th>Cliente legado</th>
              <th>Categoria</th>
              <th>Status</th>
              <th>Válido</th>
              <th>Opt-out</th>
              <th>Listas</th>
              <th>Atualizado em</th>
              <th></th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={8} cols={12} />
          ) : (
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={12}>
                    <EmptyState title="Nenhum contato. Importe um CSV." />
                  </td>
                </tr>
              ) : (
                filtered.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      <span
                        className={`cb${selected.includes(contact.id) ? ' on' : ''}`}
                        role="checkbox"
                        aria-checked={selected.includes(contact.id)}
                        onClick={() => toggleOne(contact.id)}
                      />
                    </td>
                    <td className="cell-strong">{contact.name}</td>
                    <td className="cell-mono">{contact.phoneE164 || contact.phoneRaw || '—'}</td>
                    <td className="cell-sub">{contact.email ?? '—'}</td>
                    <td className="cell-sub">{contact.clientName ?? '—'}</td>
                    <td className="cell-sub">{contact.category ?? '—'}</td>
                    <td>
                      <Badge def={badgeFor(ENTITY_STATUS, contact.recordStatus)} />
                    </td>
                    <td>
                      {contact.isValid ? (
                        <BadgeText label="Válido" cls="success" />
                      ) : (
                        <BadgeText label="Inválido" cls="danger" />
                      )}
                    </td>
                    <td>
                      {contact.isOptedOut ? <BadgeText label="Opt-out" cls="warning" /> : <span className="cell-sub">—</span>}
                    </td>
                    <td className="cell-sub">
                      {contact.listNames.length ? contact.listNames.join(', ') : '—'}
                    </td>
                    <td className="cell-mono">{fmtDateTime(contact.updatedAt ?? contact.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="icon-act" title="Editar" onClick={() => setEditing(contact)}>
                          <EditIcon />
                        </button>
                        <button
                          className="icon-act"
                          title={contact.isOptedOut ? 'Opt-in' : 'Opt-out'}
                          disabled={busy}
                          onClick={() => toggleOpt(contact)}
                        >
                          {contact.isOptedOut ? <UnlockIcon /> : <BlockIcon />}
                        </button>
                        <button
                          className="icon-act danger"
                          title="Excluir"
                          disabled={busy}
                          onClick={() => removeContact(contact)}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
        <div className="pager">
          <span>
            {fmtInt(total)} contato(s) · página {currentPage} de {totalPages}
          </span>
          <div className="pager-btns">
            <button
              className="pager-btn"
              disabled={offset === 0 || busy}
              onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
            >
              Anterior
            </button>
            <button
              className="pager-btn"
              disabled={offset + PAGE_SIZE >= total || busy}
              onClick={() => load(offset + PAGE_SIZE)}
            >
              Próxima
            </button>
          </div>
        </div>
      </div>

      {editing ? (
        <ContactModal
          contact={editing === 'new' ? null : editing}
          lists={lists}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            push('success', 'Contato salvo.');
            load(offset);
          }}
        />
      ) : null}

      {importing ? (
        <CsvWizard
          onClose={() => setImporting(false)}
          onDone={(job) => {
            setImporting(false);
            push('success', `Importação concluída: ${job.processedRows} linha(s).`);
            load(0);
          }}
        />
      ) : null}

      <ToastHost toasts={toasts} />
    </>
  );
}

interface ContactDraft {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  clientName: string;
  category: string;
  externalRef: string;
  recordStatus: RecordStatus;
  listIds: string[];
}

function ContactModal({
  contact,
  lists,
  onClose,
  onSaved,
}: {
  contact: Contact | null;
  lists: ListItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ContactDraft>({
    firstName: contact?.firstName ?? '',
    lastName: contact?.lastName ?? '',
    phone: contact ? stripDefaultCountryCode(contact.phoneE164 || contact.phoneRaw) : '',
    email: contact?.email ?? '',
    clientName: contact?.clientName ?? '',
    category: contact?.category ?? '',
    externalRef: contact?.externalRef ?? '',
    recordStatus: contact?.recordStatus ?? 'active',
    listIds: contact ? lists.filter((l) => contact.listNames.includes(l.name)).map((l) => l.id) : [],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ContactDraft>) => setDraft((c) => ({ ...c, ...patch }));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiRequest(contact ? `/contacts/${contact.id}` : '/contacts', {
        method: contact ? 'PATCH' : 'POST',
        body: JSON.stringify({
          firstName: draft.firstName,
          lastName: emptyToNull(draft.lastName),
          phone: draft.phone,
          email: emptyToNull(draft.email),
          clientName: emptyToNull(draft.clientName),
          category: emptyToNull(draft.category),
          externalRef: emptyToNull(draft.externalRef),
          recordStatus: draft.recordStatus,
          listIds: draft.listIds,
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar contato.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title={contact ? 'Editar contato' : 'Novo contato'}
      width="wide"
      onClose={onClose}
      footer={
        <>
          {error ? (
            <span className="left" style={{ color: 'var(--danger)', fontSize: 13 }}>
              {error}
            </span>
          ) : null}
          <button className="btn tertiary md" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button className="btn primary md" onClick={submit} disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field">
          <label>
            Nome <span className="req">*</span>
          </label>
          <input className="input" value={draft.firstName} onChange={(e) => set({ firstName: e.target.value })} />
        </div>
        <div className="field">
          <label>Sobrenome</label>
          <input className="input" value={draft.lastName} onChange={(e) => set({ lastName: e.target.value })} />
        </div>
        <div className="field">
          <label>
            WhatsApp <span className="req">*</span>
          </label>
          <input
            className="input"
            placeholder="11999999999"
            value={draft.phone}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </div>
        <div className="field">
          <label>E-mail</label>
          <input className="input" type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} />
        </div>
        <div className="field">
          <label>Cliente legado</label>
          <input className="input" value={draft.clientName} onChange={(e) => set({ clientName: e.target.value })} />
        </div>
        <div className="field">
          <label>Categoria</label>
          <input className="input" value={draft.category} onChange={(e) => set({ category: e.target.value })} />
        </div>
        <div className="field">
          <label>Referência externa</label>
          <input className="input" value={draft.externalRef} onChange={(e) => set({ externalRef: e.target.value })} />
        </div>
        <div className="field">
          <label>Status</label>
          <select
            className="input"
            value={draft.recordStatus}
            onChange={(e) => set({ recordStatus: e.target.value as RecordStatus })}
          >
            <option value="active">Ativo</option>
            <option value="inactive">Inativo</option>
          </select>
        </div>
        <div className="field col-2">
          <label>Listas</label>
          <div className="row">
            {lists.length === 0 ? (
              <span className="cell-sub">Nenhuma lista criada ainda.</span>
            ) : (
              lists.map((list) => {
                const checked = draft.listIds.includes(list.id);
                return (
                  <label key={list.id} className="check-row" style={{ padding: '4px 8px' }}>
                    <span className={`cbox${checked ? ' on' : ''}`} />
                    <input
                      type="checkbox"
                      style={{ display: 'none' }}
                      checked={checked}
                      onChange={() =>
                        set({
                          listIds: checked
                            ? draft.listIds.filter((x) => x !== list.id)
                            : [...draft.listIds, list.id],
                        })
                      }
                    />
                    {list.name}
                  </label>
                );
              })
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function CsvWizard({
  onClose,
  onDone,
}: {
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
      title="Importar contatos (CSV)"
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
                  onChange={(e) =>
                    setMapping((c) => ({ ...c, [field.key]: e.target.value || null }))
                  }
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
              <span className="kpi-val">
                {fmtInt(Object.values(mapping).filter(Boolean).length)}
              </span>
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

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
function EditIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
function BlockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="9" />
      <path d="m5 5 14 14" />
    </svg>
  );
}
function UnlockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.5-2" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </svg>
  );
}
