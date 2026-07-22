'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import { CsvImportModal } from '../../components/csv-import-modal';
import {
  Badge,
  BadgeText,
  DEFAULT_PAGE_SIZE,
  EmptyState,
  ErrorBanner,
  Modal,
  type PageSize,
  PageSizeSelect,
  SkeletonRows,
  ToastHost,
  useToasts,
} from '../../components/ui';
import { apiRequest } from '../../lib/api';
import { ENTITY_STATUS, badgeFor } from '../../lib/badges';
import { fmtDateTime, fmtInt } from '../../lib/format';
import { downloadCsv } from '../../lib/csv';

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
  hasFailedMessage?: boolean;
  hasDeliveredUnread?: boolean;
  listNames: string[];
  listIds: string[];
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

/* "Todos" vira um limit alto no backend (sem cap server-side). */
const ALL_LIMIT = 1_000_000;

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

interface ContactFilters {
  search: string;
  category: string;
  status: string;
  valid: string;
  optOut: string;
  listFilter: string;
}

/**
 * Predicado dos filtros da tela. Fonte única usada tanto pela tabela quanto pela
 * exportação — assim o CSV exportado reflete exatamente o que está filtrado.
 */
const matchesContactFilters = (c: Contact, f: ContactFilters): boolean => {
  if (f.category && c.category !== f.category) return false;
  if (f.status && c.recordStatus !== f.status) return false;
  if (f.valid === 'valid' && !c.isValid) return false;
  if (f.valid === 'invalid' && c.isValid) return false;
  if (f.optOut === 'out' && !c.isOptedOut) return false;
  if (f.optOut === 'in' && c.isOptedOut) return false;
  if (f.listFilter && !c.listIds.includes(f.listFilter)) return false;
  const term = f.search.trim().toLowerCase();
  if (term) {
    const hay = `${c.name} ${c.phoneE164} ${c.email ?? ''} ${c.clientName ?? ''}`.toLowerCase();
    if (!hay.includes(term)) return false;
  }
  return true;
};

/** Cabeçalho do CSV de exportação — mesmo contrato de nomes lido na importação. */
const EXPORT_HEADERS = [
  'id',
  'external_ref',
  'nome_completo',
  'telefone',
  'email',
  'cliente_legado',
  'categoria',
  'status',
  'valido',
  'opt_out',
  'situacao_falha',
  'situacao_nao_lida',
  'listas',
  'criado_em',
  'atualizado_em',
] as const;

const contactToCsvRow = (c: Contact): Array<unknown> => [
  c.id,
  c.externalRef ?? '',
  c.name,
  c.phoneE164 || c.phoneRaw || '',
  c.email ?? '',
  c.clientName ?? '',
  c.category ?? '',
  c.recordStatus === 'active' ? 'Ativo' : 'Inativo',
  c.isValid ? 'Válido' : 'Inválido',
  c.isOptedOut ? 'Sim' : 'Não',
  c.hasFailedMessage ? 'Sim' : 'Não',
  c.hasDeliveredUnread ? 'Sim' : 'Não',
  c.listNames.join('; '),
  c.createdAt,
  c.updatedAt ?? c.createdAt,
];

export default function ContactsPage() {
  return (
    <AppShell title="Contatos">
      <ContactsContent />
    </AppShell>
  );
}

function ContactsContent() {
  const { scopeClientId } = useShell();
  const { toasts, push } = useToasts();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  const limit = pageSize === 'all' ? ALL_LIMIT : pageSize;
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
  const [bulkListId, setBulkListId] = useState('');
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(
    (nextOffset = 0) => {
      setLoading(true);
      setError(null);
      const q = scopeClientId ? `&clientId=${encodeURIComponent(scopeClientId)}` : '';
      Promise.all([
        apiRequest<PaginatedContactsResponse>(
          `/contacts?limit=${limit}&offset=${nextOffset}${q}`,
        ),
        apiRequest<ListItem[]>(`/lists${scopeClientId ? `?clientId=${encodeURIComponent(scopeClientId)}` : ''}`),
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
    [scopeClientId, limit],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  const categories = useMemo(
    () => Array.from(new Set(contacts.map((c) => c.category).filter(Boolean))) as string[],
    [contacts],
  );

  const activeFilters = useMemo<ContactFilters>(
    () => ({ search, category, status, valid, optOut, listFilter }),
    [search, category, status, valid, optOut, listFilter],
  );

  const filtered = useMemo(
    () => contacts.filter((c) => matchesContactFilters(c, activeFilters)),
    [contacts, activeFilters],
  );

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

  // Exporta o conjunto FILTRADO inteiro (não só a página carregada): busca todos
  // os contatos do escopo e reaplica os mesmos filtros da tela antes de gerar o CSV.
  const exportCsv = async () => {
    setExporting(true);
    try {
      const q = scopeClientId ? `&clientId=${encodeURIComponent(scopeClientId)}` : '';
      const page = await apiRequest<PaginatedContactsResponse>(
        `/contacts?limit=${ALL_LIMIT}&offset=0${q}`,
      );
      const rows = page.items
        .filter((c) => matchesContactFilters(c, activeFilters))
        .map(contactToCsvRow);
      if (rows.length === 0) {
        push('warning', 'Nenhum contato para exportar com os filtros atuais.');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadCsv(`contatos-${stamp}.csv`, [...EXPORT_HEADERS], rows);
      push('success', `${fmtInt(rows.length)} contato(s) exportado(s).`);
    } catch (err) {
      push('danger', err instanceof Error ? err.message : 'Falha ao exportar CSV.');
    } finally {
      setExporting(false);
    }
  };

  const allChecked = filtered.length > 0 && filtered.every((c) => selected.includes(c.id));
  const toggleAll = () =>
    setSelected(allChecked ? [] : filtered.map((c) => c.id));
  const toggleOne = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Contatos</h1>
          <p className="op-sub">Base operacional de destinatários do WhatsApp.</p>
        </div>
        <div className="op-actions">
          <button className="btn tertiary md" onClick={exportCsv} disabled={exporting || loading}>
            {exporting ? 'Exportando…' : 'Exportar CSV'}
          </button>
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
          <select
            className="flt"
            value={bulkListId}
            disabled={busy}
            onChange={(e) => setBulkListId(e.target.value)}
            aria-label="Lista para vincular ou desvincular"
          >
            <option value="">Lista…</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button
            className="btn secondary sm"
            disabled={busy || !bulkListId}
            onClick={() => runBulk('assign_list', { listId: bulkListId })}
          >
            Vincular
          </button>
          <button
            className="btn secondary sm"
            disabled={busy || !bulkListId}
            onClick={() => runBulk('remove_list', { listId: bulkListId })}
          >
            Desvincular
          </button>
          {selected.length >= 2 ? (
            <button className="btn secondary sm" disabled={busy} onClick={() => setMerging(true)}>
              Mesclar
            </button>
          ) : null}
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
            <option key={l.id} value={l.id}>
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
              <th>Situação</th>
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
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {contact.isOptedOut ? <BadgeText label="Opt-out" cls="warning" /> : null}
                        {contact.hasFailedMessage ? (
                          <span title="Alguma mensagem falhou no envio">
                            <BadgeText label="Falha" cls="danger" />
                          </span>
                        ) : null}
                        {contact.hasDeliveredUnread ? (
                          <span title="Entregue mas nunca lida">
                            <BadgeText label="Não lida" cls="warning" />
                          </span>
                        ) : null}
                        {!contact.isOptedOut && !contact.hasFailedMessage && !contact.hasDeliveredUnread ? (
                          <span className="cell-sub">—</span>
                        ) : null}
                      </div>
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
          <div className="pager-info">
            <span>
              {fmtInt(total)} contato(s) · página {currentPage} de {totalPages}
            </span>
            <PageSizeSelect value={pageSize} disabled={busy || loading} onChange={setPageSize} />
          </div>
          <div className="pager-btns">
            <button
              className="pager-btn"
              disabled={offset === 0 || busy}
              onClick={() => load(Math.max(0, offset - limit))}
            >
              Anterior
            </button>
            <button
              className="pager-btn"
              disabled={offset + limit >= total || busy}
              onClick={() => load(offset + limit)}
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

      {merging ? (
        <MergeModal
          contacts={contacts.filter((c) => selected.includes(c.id))}
          onClose={() => setMerging(false)}
          onMerged={(count) => {
            setMerging(false);
            setSelected([]);
            push('success', `${count + 1} contatos mesclados em 1.`);
            load(offset);
          }}
        />
      ) : null}

      {importing ? (
        <CsvImportModal
          clientId={scopeClientId}
          onClose={() => setImporting(false)}
          onDone={(job) => {
            setImporting(false);
            const r = job.importRecord;
            push(
              'success',
              r
                ? `Importação concluída: ${fmtInt(Math.max(0, r.totalRows - r.duplicateRows))} novo(s), ${fmtInt(r.duplicateRows)} já existente(s)${r.invalidRows ? `, ${fmtInt(r.invalidRows)} inválido(s)` : ''}.`
                : `Importação concluída: ${job.processedRows} linha(s).`,
            );
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
    listIds: contact?.listIds ?? [],
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

/**
 * Mesclagem manual de contatos duplicados. O usuário escolhe o registro
 * principal (keeper, "dados corretos"); os demais são absorvidos — listas,
 * histórico e opt-outs migram para o keeper e os perdedores são removidos.
 */
function MergeModal({
  contacts,
  onClose,
  onMerged,
}: {
  contacts: Contact[];
  onClose: () => void;
  onMerged: (mergedCount: number) => void;
}) {
  // Sugestão de keeper: o mais recente (alinha com "usar o mais novo como principal").
  const newest = useMemo(
    () =>
      [...contacts].sort(
        (a, b) =>
          new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime(),
      )[0],
    [contacts],
  );
  const [keeperId, setKeeperId] = useState(newest?.id ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const loserIds = contacts.filter((c) => c.id !== keeperId).map((c) => c.id);
      await apiRequest('/contacts/merge', {
        method: 'POST',
        body: JSON.stringify({ keeperId, loserIds }),
      });
      onMerged(loserIds.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao mesclar contatos.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Mesclar contatos"
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
          <button className="btn primary md" onClick={submit} disabled={saving || !keeperId}>
            {saving ? 'Mesclando…' : `Mesclar ${contacts.length} em 1`}
          </button>
        </>
      }
    >
      <p className="cell-sub" style={{ marginBottom: 14 }}>
        Escolha o contato <strong>principal</strong> (dados corretos). Os demais serão removidos, e suas
        listas, histórico de mensagens e opt-outs passam para o principal. Esta ação não pode ser desfeita.
      </p>
      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th style={{ width: 90 }}>Principal</th>
              <th>Nome</th>
              <th>WhatsApp</th>
              <th>Listas</th>
              <th>Atualizado</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr
                key={c.id}
                style={c.id === keeperId ? { background: 'var(--surface-2, rgba(0,0,0,0.04))' } : undefined}
              >
                <td>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="keeper"
                      checked={c.id === keeperId}
                      onChange={() => setKeeperId(c.id)}
                    />
                    {c.id === keeperId ? <BadgeText label="Principal" cls="success" /> : null}
                  </label>
                </td>
                <td className="cell-strong">{c.name}</td>
                <td className="cell-mono">{c.phoneE164 || c.phoneRaw || '—'}</td>
                <td className="cell-sub">{c.listNames.length ? c.listNames.join(', ') : '—'}</td>
                <td className="cell-mono">{fmtDateTime(c.updatedAt ?? c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {contacts.some((c) => c.phoneE164 && c.phoneE164 !== keeperContactPhone(contacts, keeperId)) ? (
        <div className="toast warning" style={{ marginTop: 12 }}>
          Os contatos selecionados têm telefones diferentes. Confirme que são a mesma pessoa antes de mesclar —
          o telefone do principal será mantido.
        </div>
      ) : null}
    </Modal>
  );
}

function keeperContactPhone(contacts: Contact[], keeperId: string): string {
  const keeper = contacts.find((c) => c.id === keeperId);
  return keeper?.phoneE164 || keeper?.phoneRaw || '';
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
