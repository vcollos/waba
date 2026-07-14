'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import { CsvImportModal, downloadCsvTemplate } from '../../components/csv-import-modal';
import {
  Badge,
  BadgeText,
  Drawer,
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
import { canWrite } from '../../lib/session';

interface CategoryStat {
  value: string;
  label: string;
  totalMembers: number;
  eligibleMembers: number;
}

interface ListRow {
  id: string;
  name: string;
  description?: string | null;
  sourceType: 'csv' | 'manual' | 'api';
  createdAt: string;
  updatedAt: string;
  totalMembers: number;
  eligibleMembers: number;
  categories: CategoryStat[];
}

interface Member {
  id: string;
  name: string;
  phoneE164: string;
  phoneRaw: string;
  category?: string | null;
  recordStatus: 'active' | 'inactive';
  isValid: boolean;
  isOptedOut: boolean;
}

interface ListDetail {
  id: string;
  name: string;
  description?: string | null;
  sourceType: 'csv' | 'manual' | 'api';
  members: Member[];
}

interface ApiToken {
  id: string;
  clientId: string | null;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  token?: string;
}

const ORIGIN_LABEL: Record<string, string> = { csv: 'CSV', manual: 'Manual', api: 'API' };
const originBadge = (source: string) =>
  source === 'csv' ? 'info' : source === 'api' ? 'roxo' : 'neutral';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

// Sufixo do tenant ativo: detalhe/edição/exclusão precisam escopar pelo mesmo
// tenant da listagem (senão o backend cai no primeiro tenant do usuário).
const clientQuery = (clientId: string | null) =>
  clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';

export default function ListsPage() {
  return (
    <AppShell title="Listas">
      <ListsContent />
    </AppShell>
  );
}

function ListsContent() {
  const { session, scopeClientId } = useShell();
  const { toasts, push } = useToasts();
  const writable = canWrite(session.role);
  const [lists, setLists] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [origin, setOrigin] = useState('');
  const [viewing, setViewing] = useState<ListRow | null>(null);
  const [editing, setEditing] = useState<ListRow | null>(null);
  const [deleting, setDeleting] = useState<ListRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showTokens, setShowTokens] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<ListRow[]>(`/lists${scopeClientId ? `?clientId=${encodeURIComponent(scopeClientId)}` : ''}`)
      .then((data) => {
        setLists(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar listas.');
        setLoading(false);
      });
  }, [scopeClientId]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return lists.filter((list) => {
      if (origin && list.sourceType !== origin) return false;
      if (term && !`${list.name} ${list.description ?? ''}`.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [lists, search, origin]);

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Listas</h1>
          <p className="op-sub">Públicos de contatos para campanhas — inclusão manual, CSV ou via API.</p>
        </div>
        {writable ? (
          <div className="op-actions">
            <button className="btn tertiary md" onClick={() => downloadCsvTemplate()}>
              Baixar template CSV
            </button>
            <button className="btn secondary md" onClick={() => setShowTokens(true)}>
              Tokens de API
            </button>
            <button className="btn secondary md" onClick={() => setImporting(true)}>
              Importar CSV
            </button>
            <button className="btn primary md" onClick={() => setCreating(true)}>
              Nova lista
            </button>
          </div>
        ) : null}
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="toolbar">
        <div className="tb-search">
          <SearchIcon />
          <input placeholder="Buscar lista" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="flt" value={origin} onChange={(e) => setOrigin(e.target.value)}>
          <option value="">Origem</option>
          <option value="csv">CSV</option>
          <option value="manual">Manual</option>
          <option value="api">API</option>
        </select>
      </div>

      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Descrição</th>
              <th>Origem</th>
              <th className="num">Total de contatos</th>
              <th className="num">Elegíveis</th>
              <th>Criada em</th>
              <th>Atualizada em</th>
              <th></th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={6} cols={8} />
          ) : (
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <EmptyState title="Nenhuma lista" />
                  </td>
                </tr>
              ) : (
                filtered.map((list) => (
                  <tr key={list.id}>
                    <td className="cell-strong">{list.name}</td>
                    <td className="cell-sub">{list.description ?? '—'}</td>
                    <td>
                      <BadgeText label={ORIGIN_LABEL[list.sourceType] ?? list.sourceType} cls={originBadge(list.sourceType)} />
                    </td>
                    <td className="num">{fmtInt(list.totalMembers)}</td>
                    <td className="num">{fmtInt(list.eligibleMembers)}</td>
                    <td className="cell-mono">{fmtDateTime(list.createdAt)}</td>
                    <td className="cell-mono">{fmtDateTime(list.updatedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn tertiary sm" onClick={() => setViewing(list)}>
                          Ver lista
                        </button>
                        {writable ? (
                          <>
                            <button className="btn tertiary sm" onClick={() => setEditing(list)}>
                              Editar
                            </button>
                            <button className="btn danger sm" onClick={() => setDeleting(list)}>
                              Excluir
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
      </div>

      {viewing ? (
        <ListDrawer
          list={viewing}
          canWrite={writable}
          scopeClientId={scopeClientId}
          onClose={() => setViewing(null)}
          onChanged={load}
        />
      ) : null}

      {creating ? (
        <CreateListModal
          scopeClientId={scopeClientId}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            push('success', 'Lista criada.');
            load();
          }}
        />
      ) : null}

      {editing ? (
        <EditListModal
          list={editing}
          scopeClientId={scopeClientId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            push('success', 'Lista atualizada.');
            load();
          }}
        />
      ) : null}

      {deleting ? (
        <DeleteListModal
          list={deleting}
          scopeClientId={scopeClientId}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            push('success', 'Lista excluída.');
            load();
          }}
        />
      ) : null}

      {importing ? (
        <CsvImportModal
          title="Importar lista (CSV)"
          clientId={scopeClientId}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            push('success', 'Lista importada.');
            load();
          }}
        />
      ) : null}

      {showTokens ? (
        <ApiTokensModal scopeClientId={scopeClientId} onClose={() => setShowTokens(false)} />
      ) : null}

      <ToastHost toasts={toasts} />
    </>
  );
}

function ListDrawer({
  list,
  canWrite: writable,
  scopeClientId,
  onClose,
  onChanged,
}: {
  list: ListRow;
  canWrite: boolean;
  scopeClientId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ListDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    void apiRequest<ListDetail>(`/lists/${list.id}${clientQuery(scopeClientId)}`)
      .then((data) => {
        setDetail(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar a lista.');
        setLoading(false);
      });
  }, [list.id, scopeClientId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const removeMember = async (contactId: string) => {
    setRemovingId(contactId);
    setError(null);
    try {
      await apiRequest(`/lists/${list.id}/members/${contactId}${clientQuery(scopeClientId)}`, {
        method: 'DELETE',
      });
      reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao remover contato.');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Drawer title={list.name} subtitle={list.description ?? undefined} onClose={onClose} width={840}>
      <div className="dl" style={{ marginBottom: 20 }}>
        <dt>Origem</dt>
        <dd>{ORIGIN_LABEL[list.sourceType] ?? list.sourceType}</dd>
        <dt>Total de contatos</dt>
        <dd>{fmtInt(list.totalMembers)}</dd>
        <dt>Elegíveis</dt>
        <dd>{fmtInt(list.eligibleMembers)}</dd>
      </div>

      {list.categories.length > 0 ? (
        <div className="block">
          <div className="block-head">
            <span className="block-title">Categorias</span>
          </div>
          <div className="row">
            {list.categories.map((cat) => (
              <span key={cat.value} className="badge brand-soft">
                {cat.label} · {fmtInt(cat.eligibleMembers)}/{fmtInt(cat.totalMembers)}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {writable ? (
        <div className="block">
          <div className="block-head">
            <span className="block-title">Adicionar contato manualmente</span>
            {adding ? null : (
              <button className="btn secondary sm" onClick={() => setAdding(true)}>
                Adicionar contato
              </button>
            )}
          </div>
          {adding ? (
            <AddContactForm
              listId={list.id}
              scopeClientId={scopeClientId}
              onCancel={() => setAdding(false)}
              onSaved={() => {
                setAdding(false);
                reload();
                onChanged();
              }}
            />
          ) : null}
        </div>
      ) : null}

      <div className="block">
        <div className="block-head">
          <span className="block-title">Membros</span>
        </div>
        {error ? <ErrorBanner message={error} /> : null}
        <div className="tbl-wrap">
          <table className="tbl dense">
            <thead>
              <tr>
                <th>Nome completo</th>
                <th>WhatsApp</th>
                <th>Categoria</th>
                <th>Status</th>
                <th>Válido</th>
                <th>Opt-out</th>
                {writable ? <th></th> : null}
              </tr>
            </thead>
            {loading ? (
              <SkeletonRows rows={6} cols={writable ? 7 : 6} />
            ) : (
              <tbody>
                {detail && detail.members.length > 0 ? (
                  detail.members.map((member) => (
                    <tr key={member.id}>
                      <td className="cell-strong">{member.name}</td>
                      <td className="cell-mono">{member.phoneE164 || member.phoneRaw || '—'}</td>
                      <td className="cell-sub">{member.category ?? '—'}</td>
                      <td>
                        <Badge def={badgeFor(ENTITY_STATUS, member.recordStatus)} />
                      </td>
                      <td>
                        {member.isValid ? (
                          <BadgeText label="Válido" cls="success" />
                        ) : (
                          <BadgeText label="Inválido" cls="danger" />
                        )}
                      </td>
                      <td>
                        {member.isOptedOut ? <BadgeText label="Opt-out" cls="warning" /> : <span className="cell-sub">—</span>}
                      </td>
                      {writable ? (
                        <td>
                          <div className="row-actions">
                            <button className="btn tertiary sm" onClick={() => setEditingMember(member)}>
                              Editar
                            </button>
                            <button
                              className="btn danger sm"
                              onClick={() => removeMember(member.id)}
                              disabled={removingId === member.id}
                            >
                              {removingId === member.id ? 'Removendo…' : 'Remover'}
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={writable ? 7 : 6}>
                      <EmptyState title="Lista sem membros" />
                    </td>
                  </tr>
                )}
              </tbody>
            )}
          </table>
        </div>
      </div>
      {editingMember ? (
        <EditMemberModal
          member={editingMember}
          scopeClientId={scopeClientId}
          onClose={() => setEditingMember(null)}
          onSaved={() => {
            setEditingMember(null);
            reload();
            onChanged();
          }}
        />
      ) : null}
    </Drawer>
  );
}

function EditMemberModal({
  member,
  scopeClientId,
  onClose,
  onSaved,
}: {
  member: Member;
  scopeClientId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState(member.name.split(' ')[0] ?? '');
  const [lastName, setLastName] = useState(member.name.split(' ').slice(1).join(' '));
  const [phone, setPhone] = useState(member.phoneE164 || member.phoneRaw || '');
  const [category, setCategory] = useState(member.category ?? '');
  const [recordStatus, setRecordStatus] = useState<'active' | 'inactive'>(member.recordStatus);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!firstName.trim() || !phone.trim()) {
      setError('Informe ao menos nome e telefone.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/contacts/${member.id}${clientQuery(scopeClientId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName,
          lastName: lastName || null,
          phone,
          category: category || null,
          recordStatus,
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
      title="Corrigir contato"
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
          <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        </div>
        <div className="field">
          <label>Sobrenome</label>
          <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
        </div>
        <div className="field">
          <label>
            WhatsApp <span className="req">*</span>
          </label>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="field">
          <label>Categoria</label>
          <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} />
        </div>
        <div className="field">
          <label>Status</label>
          <select
            className="input"
            value={recordStatus}
            onChange={(e) => setRecordStatus(e.target.value as 'active' | 'inactive')}
          >
            <option value="active">Ativo</option>
            <option value="inactive">Inativo</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}

function AddContactForm({
  listId,
  scopeClientId,
  onCancel,
  onSaved,
}: {
  listId: string;
  scopeClientId: string | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!firstName.trim() || !phone.trim()) {
      setError('Informe ao menos nome e telefone.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/contacts', {
        method: 'POST',
        body: JSON.stringify({
          firstName,
          lastName: lastName || undefined,
          phone,
          email: email || undefined,
          category: category || undefined,
          clientId: scopeClientId ?? undefined,
          listIds: [listId],
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao adicionar contato.');
      setSaving(false);
    }
  };

  return (
    <div className="form-grid" style={{ marginTop: 6 }}>
      <div className="field">
        <label>
          Nome <span className="req">*</span>
        </label>
        <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
      </div>
      <div className="field">
        <label>Sobrenome</label>
        <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
      </div>
      <div className="field">
        <label>
          WhatsApp <span className="req">*</span>
        </label>
        <input className="input" placeholder="+55 11 99999-8888" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <div className="field">
        <label>E-mail</label>
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label>Categoria</label>
        <input className="input" value={category} onChange={(e) => setCategory(e.target.value)} />
      </div>
      <div className="field" style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <button className="btn primary md" onClick={submit} disabled={saving}>
          {saving ? 'Salvando…' : 'Adicionar'}
        </button>
        <button className="btn tertiary md" onClick={onCancel} disabled={saving}>
          Cancelar
        </button>
      </div>
      {error ? (
        <div className="field col-2">
          <span style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

function CreateListModal({
  scopeClientId,
  onClose,
  onSaved,
}: {
  scopeClientId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError('Informe o nome da lista.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/lists', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: description || undefined,
          clientId: scopeClientId ?? undefined,
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar lista.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Nova lista (manual)"
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
            {saving ? 'Salvando…' : 'Criar'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field col-2">
          <label>
            Nome <span className="req">*</span>
          </label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field col-2">
          <label>Descrição</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field col-2">
          <span className="hint">
            Depois de criar, abra a lista em “Ver lista” para adicionar contatos manualmente.
          </span>
        </div>
      </div>
    </Modal>
  );
}

function EditListModal({
  list,
  scopeClientId,
  onClose,
  onSaved,
}: {
  list: ListRow;
  scopeClientId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(list.name);
  const [description, setDescription] = useState(list.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError('Informe o nome da lista.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/lists/${list.id}${clientQuery(scopeClientId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, description: description.trim() ? description : null }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar lista.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Editar lista"
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
        <div className="field col-2">
          <label>
            Nome <span className="req">*</span>
          </label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field col-2">
          <label>Descrição</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
    </Modal>
  );
}

function DeleteListModal({
  list,
  scopeClientId,
  onClose,
  onDeleted,
}: {
  list: ListRow;
  scopeClientId: string | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiRequest(`/lists/${list.id}${clientQuery(scopeClientId)}`, { method: 'DELETE' });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao excluir lista.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Excluir lista"
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
          <button className="btn danger md" onClick={submit} disabled={saving}>
            {saving ? 'Excluindo…' : 'Excluir lista'}
          </button>
        </>
      }
    >
      <p style={{ fontSize: 14, lineHeight: 1.5 }}>
        Excluir a lista <strong>{list.name}</strong> ({fmtInt(list.totalMembers)} contato(s))? Os
        contatos em si <strong>não</strong> são apagados — apenas a lista e as associações. Esta ação
        não pode ser desfeita.
      </p>
    </Modal>
  );
}

function ApiTokensModal({ scopeClientId, onClose }: { scopeClientId: string | null; onClose: () => void }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void apiRequest<ApiToken[]>(`/api-tokens${scopeClientId ? `?clientId=${encodeURIComponent(scopeClientId)}` : ''}`)
      .then((data) => {
        setTokens(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar tokens.');
        setLoading(false);
      });
  }, [scopeClientId]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!name.trim()) {
      setError('Dê um nome ao token.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const created = await apiRequest<ApiToken>('/api-tokens', {
        method: 'POST',
        body: JSON.stringify({ name, clientId: scopeClientId ?? undefined }),
      });
      setFreshToken(created.token ?? null);
      setName('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao gerar token.');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await apiRequest(`/api-tokens/${id}/revoke`, { method: 'POST' });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao revogar token.');
    }
  };

  const endpointBase = `${API_BASE}/public/v1`;

  return (
    <Modal
      title="Tokens de API — inclusão de contatos"
      width="xwide"
      onClose={onClose}
      footer={
        <button className="btn primary md" onClick={onClose}>
          Fechar
        </button>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}

      <div className="block">
        <div className="block-head">
          <span className="block-title">Gerar novo token</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>Nome do token</label>
            <input
              className="input"
              placeholder="Ex.: Integração CRM"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field" style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="btn primary md" onClick={create} disabled={creating}>
              {creating ? 'Gerando…' : 'Gerar token'}
            </button>
          </div>
        </div>
        {freshToken ? (
          <div className="toast warning" style={{ marginTop: 10 }}>
            Copie agora — o token só é exibido uma vez:
            <br />
            <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{freshToken}</code>
          </div>
        ) : null}
      </div>

      <div className="block">
        <div className="block-head">
          <span className="block-title">Tokens ativos</span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl dense">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Prefixo</th>
                <th>Criado em</th>
                <th>Último uso</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            {loading ? (
              <SkeletonRows rows={3} cols={6} />
            ) : (
              <tbody>
                {tokens.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState title="Nenhum token" />
                    </td>
                  </tr>
                ) : (
                  tokens.map((token) => (
                    <tr key={token.id}>
                      <td className="cell-strong">{token.name}</td>
                      <td className="cell-mono">{token.tokenPrefix}…</td>
                      <td className="cell-mono">{fmtDateTime(token.createdAt)}</td>
                      <td className="cell-mono">{token.lastUsedAt ? fmtDateTime(token.lastUsedAt) : '—'}</td>
                      <td>
                        {token.revokedAt ? (
                          <BadgeText label="Revogado" cls="danger" />
                        ) : (
                          <BadgeText label="Ativo" cls="success" />
                        )}
                      </td>
                      <td>
                        {token.revokedAt ? null : (
                          <button className="btn danger sm" onClick={() => revoke(token.id)}>
                            Revogar
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            )}
          </table>
        </div>
      </div>

      <div className="block">
        <div className="block-head">
          <span className="block-title">Endpoints</span>
        </div>
        <p className="cell-sub" style={{ marginBottom: 8 }}>
          Autentique com o header <code>Authorization: Bearer &lt;token&gt;</code>. Os contatos entram no tenant
          do token, isolados dos demais.
        </p>
        <pre className="code-block" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
{`# Listar listas do tenant
GET ${endpointBase}/lists

# Criar uma lista (origem API)
POST ${endpointBase}/lists
{ "name": "Novos leads", "description": "opcional" }

# Enviar contatos para uma lista (upsert por telefone)
POST ${endpointBase}/lists/{listId}/contacts
{
  "contacts": [
    { "name": "Maria da Silva", "phone": "+5511999998888", "email": "maria@exemplo.com", "category": "Titular" }
  ]
}`}
        </pre>
      </div>
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
