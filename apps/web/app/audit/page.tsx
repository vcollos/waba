'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import { EmptyState, ErrorBanner, Forbidden, SkeletonRows } from '../../components/ui';
import { apiRequest } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { isCollosRole } from '../../lib/session';

interface AuditEntry {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
}

export default function AuditPage() {
  return (
    <AppShell title="Auditoria">
      <AuditContent />
    </AppShell>
  );
}

function AuditContent() {
  const { session } = useShell();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [entity, setEntity] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<AuditEntry[]>('/audit')
      .then((data) => {
        setEntries(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar auditoria.');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (isCollosRole(session.role)) load();
  }, [load, session.role]);

  const actors = useMemo(
    () =>
      Array.from(
        new Map(
          entries
            .filter((e) => e.actorUserId)
            .map((e) => [e.actorUserId as string, e.actorName ?? e.actorUserId] as const),
        ).entries(),
      ),
    [entries],
  );
  const actions = useMemo(() => Array.from(new Set(entries.map((e) => e.action))), [entries]);
  const entities = useMemo(() => Array.from(new Set(entries.map((e) => e.entityType))), [entries]);

  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (actor && e.actorUserId !== actor) return false;
        if (action && e.action !== action) return false;
        if (entity && e.entityType !== entity) return false;
        return true;
      }),
    [entries, actor, action, entity],
  );

  if (!isCollosRole(session.role)) {
    return <Forbidden />;
  }

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Auditoria</h1>
          <p className="op-sub">Registro de ações administrativas e operacionais.</p>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="toolbar">
        <select className="flt" value={actor} onChange={(e) => setActor(e.target.value)}>
          <option value="">Usuário</option>
          {actors.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select className="flt" value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">Ação</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select className="flt" value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">Entidade</option>
          {entities.map((en) => (
            <option key={en} value={en}>
              {en}
            </option>
          ))}
        </select>
      </div>

      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th>Data</th>
              <th>Usuário</th>
              <th>Ação</th>
              <th>Entidade</th>
              <th>ID da entidade</th>
              <th>Metadados</th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={8} cols={6} />
          ) : (
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState title="Nenhum registro" />
                  </td>
                </tr>
              ) : (
                filtered.map((entry) => (
                  <tr key={entry.id}>
                    <td className="cell-mono">{fmtDateTime(entry.createdAt)}</td>
                    <td className="cell-sub">{entry.actorName ?? entry.actorUserId ?? '—'}</td>
                    <td className="cell-strong">{entry.action}</td>
                    <td className="cell-sub">{entry.entityType}</td>
                    <td className="cell-mono">{entry.entityId}</td>
                    <td>
                      {Object.keys(entry.metadata).length ? (
                        <code style={{ fontSize: 11 }}>{JSON.stringify(entry.metadata)}</code>
                      ) : (
                        <span className="cell-sub">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
      </div>
    </>
  );
}
