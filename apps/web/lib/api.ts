'use client';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4311/api';
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export const readToken = (): string | null =>
  typeof window === 'undefined' ? null : window.localStorage.getItem('campaign_sender_token');

export const writeToken = (token: string) => {
  window.localStorage.setItem('campaign_sender_token', token);
};

export const clearToken = () => {
  window.localStorage.removeItem('campaign_sender_token');
};

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  authenticated = true,
): Promise<T> {
  const method = (options.method ?? (options.body ? 'POST' : 'GET')).toUpperCase();
  const headers = new Headers(options.headers ?? {});
  if (options.body && !headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  if (authenticated) {
    const token = readToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const request = () =>
    fetch(`${API_BASE}${path}`, {
      ...options,
      method,
      headers,
    });

  let response: Response;
  try {
    response = await request();
  } catch (error) {
    if (method === 'GET') {
      await sleep(800);
      response = await request();
    } else {
      throw error;
    }
  }

  if (method === 'GET' && RETRYABLE_STATUS.has(response.status)) {
    await sleep(1000);
    response = await request();
  }

  if (response.status === 401) {
    clearToken();
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      String((payload as { message?: string }).message ?? `Erro ${response.status}`),
    );
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Baixa um arquivo de um endpoint autenticado (ex.: CSV) via fetch + blob. */
export async function apiDownload(path: string, fileName: string): Promise<void> {
  const headers = new Headers();
  const token = readToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, { headers });
  if (response.status === 401) {
    clearToken();
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    return;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(String((payload as { message?: string }).message ?? `Erro ${response.status}`));
  }

  const blob = await response.blob();
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
 * Abre um recurso autenticado (ex.: HTML print-ready) em nova aba via blob.
 * O Bearer fica no localStorage, então uma URL crua em `window.open` não
 * carrega o header — buscamos com auth e servimos o blob na aba já aberta.
 */
export async function apiOpenBlob(path: string): Promise<void> {
  // Abre a aba de forma síncrona (evita bloqueio de pop-up após o await).
  const tab = typeof window !== 'undefined' ? window.open('', '_blank') : null;

  const headers = new Headers();
  const token = readToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { headers });
  } catch (error) {
    tab?.close();
    throw error;
  }

  if (response.status === 401) {
    clearToken();
    tab?.close();
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    return;
  }
  if (!response.ok) {
    tab?.close();
    const payload = await response.json().catch(() => ({}));
    throw new Error(String((payload as { message?: string }).message ?? `Erro ${response.status}`));
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  if (tab) {
    tab.location.href = url;
  } else if (typeof window !== 'undefined') {
    window.open(url, '_blank');
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
