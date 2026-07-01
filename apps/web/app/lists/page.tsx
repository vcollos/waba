'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/app-shell';
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

const ORIGIN_LABEL: Record<string, string> = { csv: 'CSV', manual: 'Manual', api: 'API' };
const originBadge = (source: string) =>
  source === 'csv' ? 'info' : source === 'api' ? 'roxo' : 'neutral';

export default function ListsPage() {
  return (
    <AppShell title="Listas">
      <ListsContent />
    </AppShell>
  );
}

function ListsContent() {
  const { toasts, push } = useToasts();
  const [lists, setLists] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [origin, setOrigin] = useState('');
  const [viewing, setViewing] = useState<ListRow | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<ListRow[]>('/lists')
      .then((data) => {
        setLists(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar listas.');
        setLoading(false);
      });
  }, []);

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
          <p className="op-sub">Públicos de contatos para campanhas.</p>
        </div>
        <div className="op-actions">
          <button className="btn primary md" onClick={() => setCreating(true)}>
            Nova lista
          </button>
        </div>
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
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
      </div>

      {viewing ? <ListDrawer list={viewing} onClose={() => setViewing(null)} /> : null}

      {creating ? (
        <CreateListModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            push('success', 'Lista criada.');
            load();
          }}
        />
      ) : null}

      <ToastHost toasts={toasts} />
    </>
  );
}

function ListDrawer({ list, onClose }: { list: ListRow; onClose: () => void }) {
  const [detail, setDetail] = useState<ListDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    void apiRequest<ListDetail>(`/lists/${list.id}`)
      .then((data) => {
        setDetail(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar a lista.');
        setLoading(false);
      });
  }, [list.id]);

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
              </tr>
            </thead>
            {loading ? (
              <SkeletonRows rows={6} cols={6} />
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
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState title="Lista sem membros" />
                    </td>
                  </tr>
                )}
              </tbody>
            )}
          </table>
        </div>
      </div>
    </Drawer>
  );
}

function CreateListModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
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
        body: JSON.stringify({ name, description: description || undefined }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar lista.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Nova lista"
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
