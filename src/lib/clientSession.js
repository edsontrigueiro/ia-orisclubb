'use client';

// Centraliza toda a gestão de sessão no client: armazenamento, expiração e
// renovação automática do access_token. Antes, o token era salvo sem
// nenhuma noção de quando expirava — isso causava 401 silencioso em
// qualquer sessão ativa por mais de ~1h (vida padrão do JWT do Supabase).

const KEYS = {
  token: 'st_token',
  refresh: 'st_refresh',
  expiresAt: 'st_expires_at',
  user: 'st_user',
};

export function saveSession({ token, refresh_token, expires_at, user }) {
  if (token) {
    document.cookie = `st_token=${token}; path=/; max-age=${7 * 24 * 3600}; SameSite=Lax`;
    localStorage.setItem(KEYS.token, token);
  }
  if (refresh_token) localStorage.setItem(KEYS.refresh, refresh_token);
  if (expires_at) localStorage.setItem(KEYS.expiresAt, String(expires_at));
  if (user) localStorage.setItem(KEYS.user, JSON.stringify(user));
}

export function getStoredToken() {
  return localStorage.getItem(KEYS.token);
}

export function getStoredUser() {
  try { return JSON.parse(localStorage.getItem(KEYS.user) || 'null'); }
  catch { return null; }
}

export function clearSession() {
  document.cookie = 'st_token=; path=/; max-age=0';
  localStorage.removeItem(KEYS.token);
  localStorage.removeItem(KEYS.refresh);
  localStorage.removeItem(KEYS.expiresAt);
  localStorage.removeItem(KEYS.user);
}

function isExpiringSoon() {
  const expiresAt = Number(localStorage.getItem(KEYS.expiresAt) || 0);
  if (!expiresAt) return false; // sem info de expiração, não bloqueia o fluxo
  const nowSeconds = Date.now() / 1000;
  return expiresAt - nowSeconds < 60; // renova com 60s de margem
}

// Troca o refresh_token por um access_token novo. Retorna o novo token
// (string) em caso de sucesso, ou null se o refresh_token também for
// inválido/expirado (aí sim a sessão acabou de verdade).
export async function refreshSession() {
  const refresh_token = localStorage.getItem(KEYS.refresh);
  if (!refresh_token) return null;

  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.token) return null;
    saveSession(data);
    return data.token;
  } catch {
    return null;
  }
}

// Wrapper de fetch autenticado: garante token válido antes da chamada e,
// se ainda assim vier 401 (ex: token revogado, relógio do cliente
// dessincronizado), tenta renovar uma vez e refaz a chamada original.
// Se a sessão realmente acabou, retorna { sessionExpired: true } em vez de
// lançar erro genérico — quem chama decide o que mostrar pro usuário.
export async function authFetch(url, options = {}) {
  let token = getStoredToken();

  if (isExpiringSoon()) {
    const refreshed = await refreshSession();
    if (refreshed) token = refreshed;
  }

  const doFetch = (tok) => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${tok}` },
  });

  let res = await doFetch(token);

  if (res.status === 401) {
    const refreshed = await refreshSession();
    if (!refreshed) {
      clearSession();
      return { sessionExpired: true };
    }
    res = await doFetch(refreshed);
    if (res.status === 401) {
      clearSession();
      return { sessionExpired: true };
    }
  }

  return { res };
}
