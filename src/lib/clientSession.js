'use client';

// Sessão gerenciada inteiramente via cookie httpOnly (st_token / st_refresh),
// setado pelo próprio servidor em /api/auth/login|register|refresh — o
// JavaScript do client NUNCA tem acesso ao token de acesso nem ao
// refresh_token. Isso fecha o buraco que existia antes: os dois viviam em
// localStorage, então qualquer XSS no app conseguia ler e sequestrar a
// sessão. O único dado guardado no client agora é "user" (id + email), que
// não é segredo — serve só pra exibir na UI sem precisar bater no servidor
// de novo só pra mostrar o e-mail no topo da tela.

const USER_KEY = 'st_user';

export function saveSession({ user }) {
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getStoredUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); }
  catch { return null; }
}

// Pede pro servidor apagar os cookies httpOnly — JS não consegue apagar
// cookie httpOnly diretamente, só o servidor (ver /api/auth/logout). Limpa
// o localStorage primeiro, de forma síncrona, pra UI esquecer o usuário
// mesmo que a chamada de rede falhe.
export async function clearSession() {
  localStorage.removeItem(USER_KEY);
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
}

// Wrapper de fetch autenticado. O cookie httpOnly já vai junto sozinho em
// toda chamada same-origin — não precisa (nem pode) montar header
// Authorization manualmente como antes. Se vier 401 (access_token
// expirado), tenta renovar via /api/auth/refresh — que lê o st_refresh
// (também httpOnly) direto do cookie da própria requisição, sem precisar
// de nada vindo do client — e refaz a chamada original uma vez. Se o
// refresh também falhar, a sessão realmente acabou.
export async function authFetch(url, options = {}) {
  const doFetch = () => fetch(url, { ...options, credentials: 'same-origin' });

  let res = await doFetch();

  if (res.status === 401) {
    const refreshRes = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
    if (!refreshRes.ok) {
      await clearSession();
      return { sessionExpired: true };
    }
    res = await doFetch();
    if (res.status === 401) {
      await clearSession();
      return { sessionExpired: true };
    }
  }

  return { res };
}
