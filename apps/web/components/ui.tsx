'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BadgeClass, BadgeDef } from '../lib/badges';

export type ToastTone = 'success' | 'danger' | 'warning';
export interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback((tone: ToastTone, text: string) => {
    const id = ++counter.current;
    setToasts((current) => [...current, { id, tone, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3600);
  }, []);

  return { toasts, push };
}

export function ToastHost({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 200,
      }}
    >
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.tone}`}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}

export function Badge({ def }: { def: BadgeDef }) {
  return <span className={`badge ${def.cls}`}>{def.label}</span>;
}

export function BadgeText({ label, cls }: { label: string; cls: BadgeClass }) {
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function Kpi({
  label,
  value,
  foot,
}: {
  label: string;
  value: string;
  foot?: string;
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-val">{value}</span>
      {foot ? <span className="kpi-foot">{foot}</span> : null}
    </div>
  );
}

export function EmptyState({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="empty">
      <div className="empty-ico">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18" />
        </svg>
      </div>
      <div className="empty-title">{title}</div>
      {desc ? <div className="empty-desc">{desc}</div> : null}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="toast danger" style={{ marginBottom: 16 }}>
      <span style={{ flex: 1 }}>{message}</span>
      {onRetry ? (
        <button className="btn secondary sm" onClick={onRetry}>
          Tentar novamente
        </button>
      ) : null}
    </div>
  );
}

export function SkeletonRows({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: cols }).map((__, colIndex) => (
            <td key={colIndex}>
              <span className="skel" style={{ display: 'block', height: 14, width: colIndex === 0 ? '70%' : '50%' }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export function Modal({
  title,
  desc,
  onClose,
  children,
  footer,
  width,
}: {
  title: string;
  desc?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'wide' | 'xwide';
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="scrim modal-scrim" onMouseDown={onClose}>
      <div
        className={`modal${width ? ` ${width}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title">{title}</div>
            {desc ? <div className="modal-desc">{desc}</div> : null}
          </div>
          <button className="x-btn" onClick={onClose} aria-label="Fechar" type="button">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  actions,
  width,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="scrim drawer-scrim" onMouseDown={onClose}>
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={width ? { maxWidth: width } : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="drawer-head">
          <div>
            <div className="modal-title">{title}</div>
            {subtitle ? <div className="modal-desc">{subtitle}</div> : null}
          </div>
          <div className="row">
            {actions}
            <button className="x-btn" onClick={onClose} aria-label="Fechar" type="button">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

export function Forbidden() {
  return (
    <div className="empty" style={{ minHeight: '60vh' }}>
      <div className="empty-ico">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      </div>
      <div className="empty-title">Acesso restrito</div>
      <div className="empty-desc">Esta área é exclusiva da operação Collos.</div>
    </div>
  );
}

export function KpiSkeleton({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <div className="kpi" key={index}>
          <span className="skel" style={{ display: 'block', height: 12, width: '60%' }} />
          <span className="skel" style={{ display: 'block', height: 24, width: '45%', marginTop: 4 }} />
        </div>
      ))}
    </>
  );
}
