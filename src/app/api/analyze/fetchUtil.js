// Retentativa simples para erros transitórios (rate limit / instabilidade
// momentânea da API). Não tenta de novo em erros definitivos (404, 401 etc).
// timeoutMs é recriado a cada tentativa — passar um "signal" já pronto
// faria o cronômetro do timeout começar a contar ANTES da 1ª tentativa e
// continuar contando durante o retry, fazendo a 2ª tentativa abortar quase
// instantaneamente se a 1ª já tiver demorado perto do limite.
export async function fetchComRetry(url, opts = {}, { tentativas = 2, timeoutMs = 8000 } = {}) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok || ![429, 502, 503, 504].includes(res.status) || i === tentativas - 1) {
        return res;
      }
    } catch (e) {
      ultimoErro = e;
      if (i === tentativas - 1) throw ultimoErro;
    }
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
}
