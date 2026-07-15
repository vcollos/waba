'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import {
  BadgeText,
  EmptyState,
  ErrorBanner,
  Forbidden,
  SkeletonRows,
  ToastHost,
  useToasts,
} from '../../components/ui';
import { apiRequest } from '../../lib/api';
import { fmtInt } from '../../lib/format';
import { isCollosRole } from '../../lib/session';

interface OverviewClient {
  id: string;
  name: string;
}
interface OverviewList {
  id: string;
  name: string;
  clientId: string | null;
  sourceType: string;
  memberCount: number;
}
interface OverviewCampaign {
  id: string;
  name: string;
  clientId: string | null;
  status: string;
}
interface Overview {
  clients: OverviewClient[];
  lists: OverviewList[];
  campaigns: OverviewCampaign[];
}

const ORIGIN_LABEL: Record<string, string> = { csv: 'CSV', manual: 'Manual', api: 'API' };

export default function TenantOrganizerPage() {
  return (
    <AppShell title="Organização de tenants">
      <TenantOrganizerContent />
    </AppShell>
  );
}

function TenantOrganizerContent() {
  const { session } = useShell();
  const { toasts, push } = useToasts();
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<Overview>('/admin/tenants/overview')
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar.');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (isCollosRole(session.role)) load();
  }, [load, session.role]);

  const clientName = useCallback(
    (clientId: string | null) => {
      if (!clientId) return '— não atribuído';
      return data?.clients.find((c) => c.id === clientId)?.name ?? clientId;
    },
    [data],
  );

  if (!isCollosRole(session.role)) {
    return <Forbidden />;
  }

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Organização de tenants</h1>
          <p className="op-sub">
            Transfira listas (com seus contatos) e campanhas entre tenants. Somente administração
            Collos.
          </p>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <ListsSection
        loading={loading}
        lists={data?.lists ?? []}
        clients={data?.clients ?? []}
        clientName={clientName}
        onDone={(msg) => {
          push('success', msg);
          load();
        }}
        onError={(msg) => push('danger', msg)}
      />

      <CampaignsSection
        loading={loading}
        campaigns={data?.campaigns ?? []}
        clients={data?.clients ?? []}
        clientName={clientName}
        onDone={(msg) => {
          push('success', msg);
          load();
        }}
        onError={(msg) => push('danger', msg)}
      />

      <ToastHost toasts={toasts} />
    </>
  );
}

function useSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setAll = (ids: string[], on: boolean) => setSelected(on ? new Set(ids) : new Set());
  const clear = () => setSelected(new Set());
  return { selected, toggle, setAll, clear };
}

function TransferBar({
  count,
  clients,
  target,
  setTarget,
  busy,
  onTransfer,
  noun,
}: {
  count: number;
  clients: OverviewClient[];
  target: string;
  setTarget: (v: string) => void;
  busy: boolean;
  onTransfer: () => void;
  noun: string;
}) {
  return (
    <div className="toolbar" style={{ justifyContent: 'flex-start', gap: 10 }}>
      <span className="cell-sub">{count} selecionado(s)</span>
      <select className="flt" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Transferir para…</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button
        className="btn primary sm"
        onClick={onTransfer}
        disabled={busy || count === 0 || !target}
      >
        {busy ? 'Transferindo…' : `Transferir ${noun}`}
      </button>
    </div>
  );
}

function ListsSection({
  loading,
  lists,
  clients,
  clientName,
  onDone,
  onError,
}: {
  loading: boolean;
  lists: OverviewList[];
  clients: OverviewClient[];
  clientName: (id: string | null) => string;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { selected, toggle, setAll, clear } = useSelection();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const allIds = useMemo(() => lists.map((l) => l.id), [lists]);
  const allOn = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const transfer = async () => {
    setBusy(true);
    try {
      const res = await apiRequest<{ lists: number; contactsMoved: number; contactsReused: number }>(
        '/admin/tenants/transfer/lists',
        { method: 'POST', body: JSON.stringify({ listIds: [...selected], clientId: target }) },
      );
      clear();
      setTarget('');
      onDone(
        `${res.lists} lista(s) → ${clientName(target)}. ${fmtInt(res.contactsMoved)} contato(s) movido(s)` +
          (res.contactsReused
            ? `, ${fmtInt(res.contactsReused)} reaproveitado(s) (telefone já existia no destino).`
            : '.'),
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Falha ao transferir listas.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="block">
      <div className="block-head">
        <span className="block-title">Listas (movem os contatos junto)</span>
      </div>
      <TransferBar
        count={selected.size}
        clients={clients}
        target={target}
        setTarget={setTarget}
        busy={busy}
        onTransfer={transfer}
        noun="listas"
      />
      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input
                  type="checkbox"
                  checked={allOn}
                  onChange={(e) => setAll(allIds, e.target.checked)}
                />
              </th>
              <th>Nome</th>
              <th>Origem</th>
              <th>Tenant atual</th>
              <th className="num">Contatos</th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={5} cols={5} />
          ) : (
            <tbody>
              {lists.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState title="Nenhuma lista" />
                  </td>
                </tr>
              ) : (
                lists.map((list) => (
                  <tr key={list.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(list.id)}
                        onChange={() => toggle(list.id)}
                      />
                    </td>
                    <td className="cell-strong">{list.name}</td>
                    <td>
                      <BadgeText label={ORIGIN_LABEL[list.sourceType] ?? list.sourceType} cls="neutral" />
                    </td>
                    <td className="cell-sub">{clientName(list.clientId)}</td>
                    <td className="num">{fmtInt(list.memberCount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}

function CampaignsSection({
  loading,
  campaigns,
  clients,
  clientName,
  onDone,
  onError,
}: {
  loading: boolean;
  campaigns: OverviewCampaign[];
  clients: OverviewClient[];
  clientName: (id: string | null) => string;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { selected, toggle, setAll, clear } = useSelection();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const allIds = useMemo(() => campaigns.map((c) => c.id), [campaigns]);
  const allOn = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const transfer = async () => {
    setBusy(true);
    try {
      const res = await apiRequest<{ campaigns: number }>('/admin/tenants/transfer/campaigns', {
        method: 'POST',
        body: JSON.stringify({ campaignIds: [...selected], clientId: target }),
      });
      clear();
      setTarget('');
      onDone(`${res.campaigns} campanha(s) → ${clientName(target)}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Falha ao transferir campanhas.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="block">
      <div className="block-head">
        <span className="block-title">Campanhas</span>
      </div>
      <p className="hint" style={{ margin: '0 0 8px' }}>
        Retag do tenant da campanha. As mensagens já enviadas e seus destinatários permanecem como
        registro histórico — mova as listas/contatos correspondentes para manter a consistência.
      </p>
      <TransferBar
        count={selected.size}
        clients={clients}
        target={target}
        setTarget={setTarget}
        busy={busy}
        onTransfer={transfer}
        noun="campanhas"
      />
      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input
                  type="checkbox"
                  checked={allOn}
                  onChange={(e) => setAll(allIds, e.target.checked)}
                />
              </th>
              <th>Nome</th>
              <th>Status</th>
              <th>Tenant atual</th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={5} cols={4} />
          ) : (
            <tbody>
              {campaigns.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState title="Nenhuma campanha" />
                  </td>
                </tr>
              ) : (
                campaigns.map((campaign) => (
                  <tr key={campaign.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(campaign.id)}
                        onChange={() => toggle(campaign.id)}
                      />
                    </td>
                    <td className="cell-strong">{campaign.name}</td>
                    <td className="cell-sub">{campaign.status}</td>
                    <td className="cell-sub">{clientName(campaign.clientId)}</td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}
