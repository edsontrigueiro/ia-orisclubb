// Helpers pra setar/apagar os cookies httpOnly de sessão (st_token /
// st_refresh), compartilhados entre login, register, refresh e logout —
// centralizado aqui de propósito, pra evitar que as 4 rotas divergam em
// maxAge/opções com o tempo (foi exatamente esse tipo de divergência
// silenciosa entre rotas parecidas que já causou bug antes no projeto).
//
// IMPORTANTE: antes dessa mudança, o token de acesso E o refresh_token
// eram devolvidos no corpo da resposta e guardados em localStorage pelo
// client (ver clientSession.js) — qualquer XSS no app conseguia ler os
// dois e sequestrar a sessão. Agora os dois vivem SÓ em cookie httpOnly:
// o JavaScript do navegador nunca tem acesso a eles, nem pra ler nem pra
// escrever. O corpo da resposta das rotas de auth só deve conter dados
// não-sensíveis (id, email).
const ACCESS_MAX_AGE = 60 * 60;        // 1h — mesma vida do JWT do Supabase
const REFRESH_MAX_AGE = 7 * 24 * 3600; // 7 dias — mesmo prazo que já era usado antes

const BASE_OPTS = {
  httpOnly: true,
  // 'secure' força HTTPS — em dev local (http://localhost) o browser
  // rejeitaria o cookie se isso ficasse true sempre, por isso é condicional
  // ao ambiente, não porque segurança em produção seja opcional.
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
};

export function setSessionCookies(response, { access_token, refresh_token } = {}) {
  if (access_token) response.cookies.set('st_token', access_token, { ...BASE_OPTS, maxAge: ACCESS_MAX_AGE });
  if (refresh_token) response.cookies.set('st_refresh', refresh_token, { ...BASE_OPTS, maxAge: REFRESH_MAX_AGE });
}

export function clearSessionCookies(response) {
  response.cookies.set('st_token', '', { ...BASE_OPTS, maxAge: 0 });
  response.cookies.set('st_refresh', '', { ...BASE_OPTS, maxAge: 0 });
}
