'use client';

import { FormEvent, useState } from 'react';
import { apiRequest, writeToken } from '../../lib/api';
import { UserSession } from '../../lib/session';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await apiRequest<{ token: string; user: UserSession }>(
        '/auth/login',
        { method: 'POST', body: JSON.stringify({ email, password }) },
        false,
      );

      writeToken(response.token);
      window.location.href = '/dashboard';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Credenciais inválidas');
      setLoading(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand-mark">WC</div>
          <div>
            <div className="auth-brand-title">WABA Collos</div>
            <div className="auth-brand-sub">Plataforma multi-tenant</div>
          </div>
        </div>

        <h1 className="auth-title">Entrar</h1>
        <p className="auth-sub">Acesse com seu e-mail e senha da plataforma.</p>

        <form className="auth-form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">E-mail</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="password">Senha</label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          {error ? (
            <div className="auth-error" role="alert">
              <ErrorIcon />
              {error}
            </div>
          ) : null}

          <button className="btn primary lg" type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? (
              <>
                <span className="auth-spinner" /> Entrando…
              </>
            ) : (
              'Entrar'
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function ErrorIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  );
}
