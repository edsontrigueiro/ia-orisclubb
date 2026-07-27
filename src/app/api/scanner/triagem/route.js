export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getCached, setCached } from '@/lib/cache';
import { fetchComRetry } from '@/lib/fetchUtil';

// ─────────────────────────────────────────────────────────────────────────
// SCANNER DE GRADE — Estágio 1 (triagem barata)
//
// Objetivo: olhar a grade INTEIRA do dia gastando quase nada de cota
// (~1 chamada de fixtures + N páginas de odds) e ORDENAR os pares
// (jogo × mercado) que valem a análise completa — que custa 7-9 chamadas
// de API-Football + 1 chamada de IA CADA.
//
// v4 — A ODD DEIXA DE SER CORTE E VIRA ORDENAÇÃO + LEITURA.
//
// Decisão do Edson: a odd pode MOSTRAR se há valor de entrada, mas não
// pode barrar jogo nem influenciar a solução da análise. Isso já valia no
// /api/analyze (Gates 7 e 8 são explicitamente não-bloqueantes e
// odd_real_ausente saiu do sinais_fracos_count). Faltava aqui, onde a odd
// ainda era o único critério de seleção.
//
// O motivo de fundo é mais grave que preferência: selecionar por
// probabilidade implícita de-vigada é CIRCULAR. Só entram jogos em que o
// mercado já concorda que o evento é provável — e valor, por definição,
// mora onde o modelo DISCORDA do mercado. A triagem antiga era
// estruturalmente incapaz de encontrar aquilo que justifica o produto
// existir.
//
// O que mudou em relação à v3:
//   • TOLERANCIA_MARGEM_PP não filtra mais nada. Vira só rótulo
//     (dentroDaTolerancia) e leitura de valor (valorEntrada).
//   • Jogo sem odd publicada NÃO é mais descartado. Entra na fila de todos
//     os mercados, marcado semOdds, ordenado por último.
//   • A margem continua sendo a chave de ORDENAÇÃO da fila. Ordenar não é
//     barrar: nenhum jogo é excluído por causa dela, mas alguém precisa
//     decidir quem ocupa as vagas quando há 900 candidatos para 40 lugares,
//     e a odd é o único sinal obtível para a grade inteira com 2 chamadas.
//
// LIMITE HONESTO: com a grade grande, jogo sem odd fica no fim de todas as
// filas e na prática raramente sobe. Ele deixou de ser barrado, mas não
// virou prioridade. Para garantir representação a esses jogos seria
// preciso reservar cota fixa — decisão em aberto, não implementada aqui.
//
// A análise completa NÃO acontece aqui: o frontend recebe a lista de aptos
// e chama /api/analyze um par por vez, com origem 'scanner'. Esta rota não
// escreve nada além de cache.
// ─────────────────────────────────────────────────────────────────────────

// 30 min: odds do dia mudam devagar de manhã; perto do kickoff o usuário
// pode forçar refresh (?refresh=1) se quiser a foto mais recente.
const CACHE_TTL_MS = 30 * 60 * 1000;

// Ligas com histórico de calibração no sistema. NÃO é filtro por padrão —
// é etiqueta de confiança. Ampliar conforme cada liga acumule amostra
// resolvida suficiente em calibracao_por_liga.
const LIGAS_CALIBRADAS = new Set([
  2, 3,                   // Champions League, Europa League
  1,                      // Copa do Mundo
  39, 140, 135, 78, 61,   // Premier League, La Liga, Serie A, Bundesliga, Ligue 1
  71, 73,                 // Brasileirão Série A e B
  13,                     // Libertadores
  11,                     // Sul-Americana
  88, 94,                 // Eredivisie, Primeira Liga (Portugal)
  128,                    // Liga Profesional (Argentina)
  253,                    // MLS (EUA)
  262,                    // Liga MX (México)
  239,                    // Primera A (Colômbia)
  265,                    // Primera División (Chile)
  98,                     // J1 League (Japão)
  292,                    // K League 1 (Coreia do Sul)
  103, 113, 119,          // Eliteserien, Allsvenskan, Superliga (Dinamarca)
  244,                    // Veikkausliiga (Finlândia)
  106,                    // Ekstraklasa (Polônia)
  40,                     // Championship (Inglaterra)
]);

// Teto de PARES (jogo × mercado) por varredura — não de jogos. Protege a
// cota (40 × ~8 chamadas ≈ 320 requests no estágio caro) e o tempo do
// loop no frontend. Quem fica de fora NÃO é reprovado: é corte de cota.
const MAX_APTOS_PADRAO = 40;
const MAX_APTOS_TETO = 120;

// Referência de leitura de valor, em pontos percentuais em relação ao
// mínimo da estratégia. NÃO FILTRA NADA desde a v4 — serve só para rotular
// o candidato (dentro/fora da faixa de referência) na interface.
const TOLERANCIA_MARGEM_PP = 6;

// Odds vêm 20 fixtures por página. Teto derivado da grade real, com parada
// antecipada quando todos os candidatos já têm odds.
const FIXTURES_POR_PAGINA_ODDS = 20;
const TETO_ABSOLUTO_PAGINAS_ODDS = 120;

// Sem corte por margem, a sobra de candidatos passa fácil de 10.000 pares.
// Materializar tudo em `descartes` geraria um JSON gigante sem utilidade —
// a contagem por categoria já responde a pergunta. Este teto limita só o
// DETALHAMENTO; os contadores continuam completos.
const MAX_DESCARTES_DETALHADOS = 400;

// bookmaker=8 (Bet365) — mesma referência usada em buscarOddsReais do
// footballData.js, pra triagem e análise completa enxergarem o mesmo
// mercado e não divergirem entre estágios do funil.
const BOOKMAKER_ID = 8;

// Score mínimo por mercado — replica MERCADOS de /api/analyze. Usado aqui
// APENAS como referência de leitura de valor, nunca como corte. Manter em
// sincronia com aquele arquivo.
const MINIMOS = {
  'Lay 2x2':         82,
  'Dupla Chance':    86,
  '+1.5 Gols':       83,
  '+0.5 Gols':       88,
  '-2.5 Gols 1T':    86,
  'Lay Empate':      84,
  'Under 3.5 Gols':  85,
  'BTTS Não':        88,
  '+0.5 Gols 1T':    85,
  '+8.5 Escanteios': 85,
};

// Ordem de prioridade no round-robin. Mercados com odd operacional mais
// alta primeiro: quando o teto de cota corta, o que sobrevive é o que
// paga melhor. "+0.5 Gols" fica por último de propósito — é o mais fácil
// de aprovar e o que menos remunera (odds 1.05-1.10), então não pode
// voltar a monopolizar a varredura como fez na v1.
const ORDEM_MERCADOS = [
  '+8.5 Escanteios',
  'BTTS Não',
  '-2.5 Gols 1T',
  '+0.5 Gols 1T',
  'Under 3.5 Gols',
  'Lay 2x2',
  'Lay Empate',
  '+1.5 Gols',
  'Dupla Chance',
  '+0.5 Gols',
];

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Busca um mercado de aposta pelo nome tolerando variação de nomenclatura
// entre casas/planos da API-Football (ex: "Goals Over/Under First Half"
// vs "First Half Goals"). Sem isso, uma diferença de rótulo derruba o
// mercado inteiro em silêncio.
function acharBet(bets, ...candidatos) {
  for (const c of candidatos) {
    const alvo = norm(c);
    const hit = bets.find(b => norm(b.name) === alvo);
    if (hit) return hit.values || [];
  }
  for (const c of candidatos) {
    const alvo = norm(c);
    const hit = bets.find(b => norm(b.name).includes(alvo));
    if (hit) return hit.values || [];
  }
  return [];
}

function valorDe(values, ...candidatos) {
  for (const c of candidatos) {
    const alvo = norm(c);
    const hit = (values || []).find(v => norm(v.value) === alvo);
    if (hit) {
      const n = parseFloat(hit.odd);
      if (Number.isFinite(n) && n > 1) return n;
    }
  }
  return null;
}

// Probabilidade de-vigada de um par complementar (Over/Under da mesma
// linha, BTTS sim/não): remove a margem da casa normalizando os inversos.
function devigPar(oddA, oddB) {
  const a = 1 / oddA, b = 1 / oddB;
  return a / (a + b);
}

function extrairOdds(bets) {
  const mw    = acharBet(bets, 'Match Winner', '1x2', 'Full Time Result');
  const ou    = acharBet(bets, 'Goals Over/Under', 'Over/Under');
  const btts  = acharBet(bets, 'Both Teams Score', 'Both Teams To Score');
  const ouHT  = acharBet(bets, 'Goals Over/Under First Half', 'First Half Goals', 'Over/Under First Half');
  const corn  = acharBet(bets, 'Corners Over Under', 'Total Corners', 'Corners');
  const exato = acharBet(bets, 'Exact Score', 'Correct Score');

  return {
    casa:    valorDe(mw, 'Home', '1'),
    empate:  valorDe(mw, 'Draw', 'X'),
    fora:    valorDe(mw, 'Away', '2'),
    over05:  valorDe(ou, 'Over 0.5'),
    under05: valorDe(ou, 'Under 0.5'),
    over15:  valorDe(ou, 'Over 1.5'),
    under15: valorDe(ou, 'Under 1.5'),
    over35:  valorDe(ou, 'Over 3.5'),
    under35: valorDe(ou, 'Under 3.5'),
    bttsSim: valorDe(btts, 'Yes'),
    bttsNao: valorDe(btts, 'No'),
    over05HT:  valorDe(ouHT, 'Over 0.5'),
    under05HT: valorDe(ouHT, 'Under 0.5'),
    over25HT:  valorDe(ouHT, 'Over 2.5'),
    under25HT: valorDe(ouHT, 'Under 2.5'),
    over85c:   valorDe(corn, 'Over 8.5'),
    under85c:  valorDe(corn, 'Under 8.5'),
    placar22:  valorDe(exato, '2:2', '2-2'),
  };
}

// Devolve TODOS os mercados que as odds disponíveis conseguem precificar
// para este jogo — um candidato por mercado, não só o melhor.
function todasEstrategias(o) {
  const out = [];
  const add = (mercado, prob, detalhe) => {
    if (!Number.isFinite(prob)) return;
    const p = prob * 100;
    out.push({ mercado, prob: p, margem: p - MINIMOS[mercado], detalhe });
  };

  if (o.casa && o.empate && o.fora) {
    const iC = 1 / o.casa, iE = 1 / o.empate, iF = 1 / o.fora;
    const s = iC + iE + iF;
    const pCasa = iC / s, pEmpate = iE / s, pFora = iF / s;
    const favEmCasa = pCasa >= pFora;
    add('Dupla Chance', (favEmCasa ? pCasa : pFora) + pEmpate,
        favEmCasa ? '1X (mandante não perde)' : 'X2 (visitante não perde)');
    add('Lay Empate', 1 - pEmpate, `empate @ ${o.empate.toFixed(2)}`);
  }
  if (o.over15 && o.under15)      add('+1.5 Gols', devigPar(o.over15, o.under15), `over 1.5 @ ${o.over15.toFixed(2)}`);
  if (o.over05 && o.under05)      add('+0.5 Gols', devigPar(o.over05, o.under05), `over 0.5 @ ${o.over05.toFixed(2)}`);
  if (o.under35 && o.over35)      add('Under 3.5 Gols', devigPar(o.under35, o.over35), `under 3.5 @ ${o.under35.toFixed(2)}`);
  if (o.bttsNao && o.bttsSim)     add('BTTS Não', devigPar(o.bttsNao, o.bttsSim), `BTTS não @ ${o.bttsNao.toFixed(2)}`);
  if (o.over05HT && o.under05HT)  add('+0.5 Gols 1T', devigPar(o.over05HT, o.under05HT), `over 0.5 1T @ ${o.over05HT.toFixed(2)}`);
  if (o.under25HT && o.over25HT)  add('-2.5 Gols 1T', devigPar(o.under25HT, o.over25HT), `under 2.5 1T @ ${o.under25HT.toFixed(2)}`);
  if (o.over85c && o.under85c)    add('+8.5 Escanteios', devigPar(o.over85c, o.under85c), `over 8.5 esc. @ ${o.over85c.toFixed(2)}`);

  // Lay 2x2 não tem par complementar publicado — a odd do placar exato
  // 2:2 vem com a vig inteira embutida. Usar 1/odd SUPERESTIMA a chance
  // de sair 2-2 e, portanto, SUBESTIMA a probabilidade do lay: erro pro
  // lado conservador. Aceitável numa triagem que não corta nada.
  if (o.placar22) add('Lay 2x2', 1 - (1 / o.placar22), `placar 2-2 @ ${o.placar22.toFixed(2)}`);

  return out;
}

// Leitura de valor de entrada — a única coisa que a odd faz agora além de
// ordenar. Nunca vira decisão: é texto pra tela.
function leituraValor(margem) {
  if (margem == null) return 'Sem odd publicada — leitura de valor indisponível';
  if (margem >= 0) return 'Preço de mercado acima da referência do mercado-alvo';
  if (margem >= -TOLERANCIA_MARGEM_PP) return 'Preço de mercado próximo da referência';
  return 'Preço de mercado abaixo da referência — divergência a checar na análise';
}

// Agrupa os motivos de descarte em categorias estáveis. O motivo por jogo
// carrega detalhe variável, o que impediria somar — aqui a categoria é
// fixa, e é ela que responde "por que veio pouca coisa".
function categoriaDescarte(motivo) {
  if (motivo.startsWith('Jogo já iniciado')) return 'Jogo já começou ou terminou';
  if (motivo.startsWith('Liga fora')) return 'Liga fora do modo calibrado';
  if (motivo.startsWith('Corte de cota')) return 'Corte de cota (teto de aptos)';
  return 'Outro';
}

export async function GET(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const { searchParams } = new URL(request.url);

  // ── Data: explícita ou hoje ────────────────────────────────────────────
  // Mesma validação da rota jogos-do-dia — o valor vai direto pra URL da
  // API-Football e pra chave de cache, então nunca confiar na query string.
  const dataParam = searchParams.get('data');
  const data = dataParam ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return NextResponse.json({ error: 'Parâmetro "data" inválido, use YYYY-MM-DD.' }, { status: 400 });
  }

  // ── Modo de liga: todas (padrão) ou só as calibradas ───────────────────
  const modoLigas = searchParams.get('ligas') === 'calibradas' ? 'calibradas' : 'todas';

  // ── Teto de aptos ──────────────────────────────────────────────────────
  const maxParam = parseInt(searchParams.get('max') || '', 10);
  const MAX_APTOS = Number.isFinite(maxParam)
    ? Math.min(Math.max(maxParam, 1), MAX_APTOS_TETO)
    : MAX_APTOS_PADRAO;

  const forcarRefresh = searchParams.get('refresh') === '1';

  const chave = `scanner-triagem-v4::${data}::${modoLigas}::${MAX_APTOS}`;
  if (!forcarRefresh) {
    const cacheado = await getCached(chave, CACHE_TTL_MS);
    if (cacheado) return NextResponse.json({ ...cacheado, _cache: true });
  }

  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return NextResponse.json({ error: 'FOOTBALL_API_KEY não configurada.' }, { status: 500 });
  const headers = { 'x-apisports-key': key };
  let requestsGastos = 0;

  try {
    // ── Grade do dia ────────────────────────────────────────────────────
    // Reaproveita o cache da aba Jogos do Dia quando existir — economiza
    // a chamada de fixtures inteira se o usuário já abriu aquela aba.
    let jogosGrade = null;
    const cacheGrade = await getCached(`jogos-do-dia::${data}`, 60 * 60 * 1000);
    if (cacheGrade?.jogos?.length) {
      jogosGrade = cacheGrade.jogos;
    } else {
      const res = await fetchComRetry(
        `https://v3.football.api-sports.io/fixtures?date=${data}&timezone=America/Sao_Paulo`,
        { headers }, { timeoutMs: 15000 }
      );
      requestsGastos++;
      if (!res.ok) {
        return NextResponse.json({ error: 'Falha ao buscar a grade do dia na API-Football.' }, { status: 502 });
      }
      const json = await res.json();
      jogosGrade = (json?.response || []).map(f => ({
        id: f.fixture?.id,
        hora: f.fixture?.date,
        status: f.fixture?.status?.short || null,
        liga: f.league?.name || 'Outra liga',
        ligaId: f.league?.id ?? null,
        season: f.league?.season ?? null,
        pais: f.league?.country || null,
        timeA: f.teams?.home?.name || '?',
        timeB: f.teams?.away?.name || '?',
        // IDs numéricos dos times, direto da API-Football. Guardar aqui é o
        // que permite o estágio caro pular a resolução por nome
        // (teams?search=), que quebra com acento, hífen e nome composto.
        timeAId: f.teams?.home?.id ?? null,
        timeBId: f.teams?.away?.id ?? null,
      }));
    }

    const totalGrade = jogosGrade.length;
    const descartes = [];
    const contadorDescartes = {};
    let descartesOmitidos = 0;

    const registrarDescarte = (evento, liga, motivo) => {
      const cat = categoriaDescarte(motivo);
      contadorDescartes[cat] = (contadorDescartes[cat] || 0) + 1;
      if (descartes.length < MAX_DESCARTES_DETALHADOS) descartes.push({ evento, liga, motivo });
      else descartesOmitidos++;
    };

    const candidatosPorFixture = new Map();
    for (const j of jogosGrade) {
      const evento = `${j.timeA} vs ${j.timeB}`;
      // Só jogo que ainda não começou: o pipeline de análise inteiro
      // (forma recente, odds pré-jogo, Gates) assume estado pré-jogo.
      if (j.status && j.status !== 'NS' && j.status !== 'TBD') {
        registrarDescarte(evento, j.liga, 'Jogo já iniciado ou encerrado');
        continue;
      }
      if (modoLigas === 'calibradas' && !LIGAS_CALIBRADAS.has(j.ligaId)) {
        registrarDescarte(evento, j.liga, 'Liga fora da cobertura calibrada do scanner');
        continue;
      }
      candidatosPorFixture.set(j.id, j);
    }

    // ── Odds do dia (paginadas) ─────────────────────────────────────────
    // Teto derivado da grade real, não fixo: com todas as ligas liberadas
    // um teto baixo fazia jogo legítimo virar "sem odds", diagnóstico
    // falso. O laço para assim que todo candidato tiver odds.
    const tetoPaginas = Math.min(
      TETO_ABSOLUTO_PAGINAS_ODDS,
      Math.ceil((candidatosPorFixture.size || 1) / FIXTURES_POR_PAGINA_ODDS) + 15
    );

    const oddsPorFixture = new Map();
    let pagina = 1, totalPaginas = 1, paginasLidas = 0, truncouOdds = false;
    while (pagina <= totalPaginas && pagina <= tetoPaginas && candidatosPorFixture.size > 0) {
      if (oddsPorFixture.size >= candidatosPorFixture.size) break;

      const res = await fetchComRetry(
        `https://v3.football.api-sports.io/odds?date=${data}&bookmaker=${BOOKMAKER_ID}&page=${pagina}&timezone=America/Sao_Paulo`,
        { headers }, { timeoutMs: 15000 }
      );
      requestsGastos++;
      paginasLidas++;
      if (!res.ok) { truncouOdds = true; break; } // triagem parcial > triagem nenhuma
      const json = await res.json();
      totalPaginas = json?.paging?.total || 1;
      for (const item of json?.response || []) {
        const fid = item?.fixture?.id;
        if (!fid || !candidatosPorFixture.has(fid)) continue;
        const bets = item?.bookmakers?.[0]?.bets;
        if (bets?.length) oddsPorFixture.set(fid, extrairOdds(bets));
      }
      pagina++;
    }
    if (pagina <= totalPaginas && oddsPorFixture.size < candidatosPorFixture.size) truncouOdds = true;

    // ── Montagem dos candidatos ─────────────────────────────────────────
    // NENHUM descarte por odd aqui. Jogo com odd gera um candidato por
    // mercado precificado; jogo sem odd gera candidato para TODOS os
    // mercados, marcado semOdds. A odd só decide POSIÇÃO na fila.
    const candidatos = [];
    let semOddsCount = 0;

    for (const [fid, j] of candidatosPorFixture) {
      const evento = `${j.timeA} vs ${j.timeB}`;
      const base = {
        fixtureId: fid,
        evento, timeA: j.timeA, timeB: j.timeB, liga: j.liga, hora: j.hora,
        // Repassados de propósito: são eles que permitem ao estágio caro
        // identificar o confronto sem busca por nome.
        timeAId: j.timeAId,
        timeBId: j.timeBId,
        ligaId: j.ligaId,
        season: j.season,
        ligaCalibrada: LIGAS_CALIBRADAS.has(j.ligaId),
      };

      const odds = oddsPorFixture.get(fid);
      const avaliados = odds ? todasEstrategias(odds) : [];

      if (avaliados.length) {
        for (const e of avaliados) {
          const margem = Math.round(e.margem * 10) / 10;
          candidatos.push({
            ...base,
            chave: `${fid}::${e.mercado}`,
            mercado: e.mercado,
            semOdds: false,
            probImplicita: Math.round(e.prob * 10) / 10,
            margem,
            dentroDaTolerancia: margem >= -TOLERANCIA_MARGEM_PP,
            valorEntrada: leituraValor(margem),
            detalhe: e.detalhe,
          });
        }
      } else {
        // Sem odd publicada (ou odds que não cobrem nenhum mercado) o jogo
        // NÃO é mais descartado. Como não há preço, não há como escolher o
        // mercado: entra em todos, no fim de cada fila.
        semOddsCount++;
        for (const mercado of ORDEM_MERCADOS) {
          candidatos.push({
            ...base,
            chave: `${fid}::${mercado}`,
            mercado,
            semOdds: true,
            probImplicita: null,
            margem: null,
            dentroDaTolerancia: null,
            valorEntrada: leituraValor(null),
            detalhe: odds ? 'odds publicadas não cobrem este mercado' : 'sem odds publicadas (Bet365)',
          });
        }
      }
    }

    // ── Seleção round-robin por mercado ─────────────────────────────────
    // Sem isso, ordenar tudo por margem faria um único mercado ocupar as
    // vagas (foi o que aconteceu na v1 com "+0.5 Gols"). Cada rodada leva
    // o melhor candidato AINDA NÃO escolhido de cada mercado.
    //
    // Critério de fila, nesta ordem: (1) tem odd antes de não tem —
    // candidato sem preço não pula na frente de quem tem leitura; (2) liga
    // calibrada antes de não calibrada; (3) margem maior antes. Nenhum
    // desses exclui ninguém: só define quem entra primeiro no teto.
    const porMercado = new Map();
    for (const c of candidatos) {
      if (!porMercado.has(c.mercado)) porMercado.set(c.mercado, []);
      porMercado.get(c.mercado).push(c);
    }
    for (const lista of porMercado.values()) {
      lista.sort((a, b) => {
        if (a.semOdds !== b.semOdds) return a.semOdds ? 1 : -1;
        if (a.ligaCalibrada !== b.ligaCalibrada) return a.ligaCalibrada ? -1 : 1;
        return (b.margem ?? -999) - (a.margem ?? -999);
      });
    }

    const aptos = [];
    let restam = true;
    while (aptos.length < MAX_APTOS && restam) {
      restam = false;
      for (const mercado of ORDEM_MERCADOS) {
        const fila = porMercado.get(mercado);
        if (!fila?.length) continue;
        restam = true;
        aptos.push(fila.shift());
        if (aptos.length >= MAX_APTOS) break;
      }
    }

    // O que sobrou passou do teto — corte de cota, nunca "reprovado".
    // Só contabilizado (e detalhado até o teto), porque sem corte por
    // margem a sobra pode passar de 10.000 pares.
    for (const [mercado, fila] of porMercado) {
      for (const excedente of fila) {
        registrarDescarte(
          excedente.evento, excedente.liga,
          `Corte de cota — fora do teto de ${MAX_APTOS} análises (estava na fila: ${mercado}${
            excedente.margem == null ? ', sem odd' : `, ${excedente.margem >= 0 ? '+' : ''}${excedente.margem}pp`
          })`
        );
      }
    }

    const resumoMercados = {};
    for (const a of aptos) resumoMercados[a.mercado] = (resumoMercados[a.mercado] || 0) + 1;

    const payload = {
      data,
      modoLigas,
      maxAptos: MAX_APTOS,
      totalGrade,
      totalPreSelecionados: candidatosPorFixture.size,
      totalComOdds: oddsPorFixture.size,
      totalSemOdds: semOddsCount,
      totalCandidatos: candidatos.length,
      aptosSemOdds: aptos.filter(a => a.semOdds).length,
      aptosNaoCalibrados: aptos.filter(a => !a.ligaCalibrada).length,
      aptosForaDaTolerancia: aptos.filter(a => a.dentroDaTolerancia === false).length,
      truncouOdds,
      resumoMercados,
      resumoDescartes: contadorDescartes,
      descartesOmitidos,
      aptos,
      descartes,
      _requests: requestsGastos,
      _paginasOdds: paginasLidas,
    };
    await setCached(chave, payload);
    return NextResponse.json(payload);
  } catch (e) {
    console.error(JSON.stringify({ etapa: 'scanner-triagem', data, erro: e.message }));
    return NextResponse.json({ error: 'Erro na triagem da grade.' }, { status: 500 });
  }
}
