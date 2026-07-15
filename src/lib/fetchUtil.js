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
        // AUDITORIA jul/2026: antes disso, uma resposta não-ok que esgotava
        // as tentativas voltava em silêncio pro chamador (que geralmente só
        // faz "if (!res.ok) return null"), sem log nenhum em lugar nenhum —
        // Vercel Logs ficava vazio mesmo com rate limit (429) acontecendo de
        // verdade. Loga aqui, uma vez só, cobre todo mundo que usa essa
        // função sem precisar mexer em cada chamador individualmente.
        if (!res.ok) {
          console.error(JSON.stringify({
            ts: new Date().toISOString(),
            etapa: 'fetchComRetry_esgotou_tentativas',
            url,
            status: res.status,
            tentativas: i + 1,
          }));
        }
        return res;
      }
    } catch (e) {
      ultimoErro = e;
      if (i === tentativas - 1) throw ultimoErro;
    }
    await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
}
