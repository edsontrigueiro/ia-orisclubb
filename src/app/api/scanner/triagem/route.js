export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getCached, setCached } from '@/lib/cache';
import { fetchComRetry } from '@/lib/fetchUtil';

// ─────────────────────────────────────────────────────────────────────────
// SCANNER DE GRADE — Estágio 1 (triagem barata)
//
// Objetivo: olhar a grade INTEIRA do dia gastando quase nada de cota
// (~1 chamada de fixtures + ~15-30 páginas de odds) e devolver os pares
// (jogo × mercado) que valem a análise completa — que custa 7-9 chamadas
// de API-Football + 1 chamada de IA CADA.
//
// v2 — TODOS OS MERCADOS. A v1 fazia cada jogo competir com UM único
// mercado (o de maior margem). Como "+0.5 Gols" tem probabilidade
// implícita altíssima em praticamente qualquer jogo (~92%), ele vencia a
// disputa interna sempre e o scanner virou um detector de "+0.5 Gols" —
// 36 aptos, 36 vezes o mesmo mercado, odds de 1.05. Agora cada jogo gera
// um candidato POR MERCADO elegível, e a seleção final é round-robin
// (um de cada mercado por rodada, do maior pro menor margem), o que
// garante variedade de mercado dentro do mesmo teto de cota.
//
// A análise completa NÃO acontece aqui: o frontend (aba Scanner) recebe a
// lista de aptos e chama /api/analyze um par por vez, com origem
// 'scanner' — reusando o pipeline que já existe e já grava em
// analises_historico. Esta rota não escreve nada além de cache.
// ─────────────────────────────────────────────────────────────────────────

// 30 min: odds do dia mudam devagar de manhã; perto do kickoff o usuário
// pode forçar refresh (?refresh=1) se quiser a foto mais recente.
const CACHE_TTL_MS = 30 * 60 * 1000;

// Ligas onde a cobertura de dados da API-Football já se provou boa o
// bastante pros Gates. O scanner SÓ considera essas — liga fora daqui é
// descartada com motivo. Racional: na análise manual o Gate 2 protege
// caso a caso; numa varredura em massa, gastar 8 chamadas por jogo pra
// descobrir que o dado é ruim inverte a lógica do funil. Pra ampliar
// cobertura, adicionar o ID aqui é o único passo.
const LIGAS_COBERTAS = new Set([
  2, 3,                   // Champions League, Europa League
  1,                      // Copa do Mundo
  39, 140, 135, 78, 61,   // Premier League, La Liga, Serie A, Bundesliga, Ligue 1
  71, 73,                 // Brasileirão Série A e B
  13,                     // Libertadores
  11,                     // Sul-Americana
  88, 94,                 // Eredivisie, Primeira Liga (Portugal)
  128,                    // Liga Profesional (Argentina)
  // Ligas de calendário "verão europeu" — sem elas, a triagem em jun-ago
  // descarta quase a grade inteira (as top europeias estão de férias):
  253,                    // MLS (EUA)
  262,                    // Liga MX (México)
  239,                    // Primera A (Colômbia)
  265,                    // Primera División (Chile)
  98,                     // J1 League (Japão)
  292,                    // K League 1 (Coreia do Sul)
  103, 113, 119,          // Eliteserien (Noruega), Allsvenskan (Suécia), Superliga (Dinamarca)
  244,                    // Veikkausliiga (Finlândia)
  106,                    // Ekstraklasa (Polônia)
  40,                     // Championship (Inglaterra)
]);

// Teto de PARES (jogo × mercado) por varredura — não de jogos. Protege a
// cota (40 × ~8 chamadas ≈ 320 requests no estágio caro) e o tempo do
// loop no frontend (40 × ~10s ≈ 7 min). Quem passa do corte NÃO é
// reprovado: é descartado com motivo explícito de corte, pra ficar claro
// que foi cota, não mérito.
const MAX_APTOS = 40;

// Tolerância da triagem, em pontos percentuais ABAIXO do mínimo da
// estratégia. Racional: exigir margem >= 0 (odd de mercado já acima do
// mínimo) seria MAIS rígido que o próprio pipeline — no /api/analyze o
// Gate 7 (essa mesma comparação) é informativo, não bloqueante. A zona
// logo abaixo do mínimo é justamente onde o dado real pode divergir do
// mercado a favor. O corte de verdade continua sendo dos Gates 0-25 + IA.
const TOLERANCIA_MARGEM_PP = 6;

// Teto de páginas de odds (20 fixtures/página). 30 páginas cobrem 600
// jogos com odds — mais que qualquer grade real das ligas cobertas.
const MAX_PAGINAS_ODDS = 30;

// bookmaker=8 (Bet365) — mesma referência usada em buscarOddsReais do
// footballData.js, pra triagem e análise completa enxergarem o mesmo
// mercado e não divergirem entre estágios do funil.
const BOOKMAKER_ID = 8;

// Score mínimo por mercado — replica MERCADOS de /api/analyze. A triagem
// usa a MESMA régua do funil, só que antes e de graça. Manter em sincronia
// com aquele arquivo: se um mínimo mudar lá, mudar aqui também.
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
// paga melhor. "+0.5 Gols" fica por último de propósito — ele é o mais
// fácil de aprovar e o que menos remunera (odds 1.05-1.10), então não
// pode voltar a monopolizar a varredura.
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
  // lado conservador (pode deixar passar candidato bom, nunca aprova
  // candidato ruim). Aceitável numa triagem cujo corte real são os Gates.
  if (o.placar22) add('Lay 2x2', 1 - (1 / o.placar22), `placar 2-2 @ ${o.placar22.toFixed(2)}`);

  return out;
}

export async function GET(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const data = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const forcarRefresh = searchParams.get('refresh') === '1';

  const chave = `scanner-triagem-v2::${data}`;
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
    // a chamada de fixtures inteira se o usuário já abriu aquela aba hoje.
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
        pais: f.league?.country || null,
        timeA: f.teams?.home?.name || '?',
        timeB: f.teams?.away?.name || '?',
      }));
    }

    const totalGrade = jogosGrade.length;
    const descartes = [];
    const candidatosPorFixture = new Map();

    for (const j of jogosGrade) {
      const evento = `${j.timeA} vs ${j.timeB}`;
      // Só jogo que ainda não começou: o pipeline de análise inteiro
      // (forma recente, odds pré-jogo, Gates) assume estado pré-jogo.
      if (j.status && j.status !== 'NS' && j.status !== 'TBD') {
        descartes.push({ evento, liga: j.liga, motivo: 'Jogo já iniciado ou encerrado' });
        continue;
      }
      if (!LIGAS_COBERTAS.has(j.ligaId)) {
        descartes.push({ evento, liga: j.liga, motivo: 'Liga fora da cobertura calibrada do scanner' });
        continue;
      }
      candidatosPorFixture.set(j.id, j);
    }

    // ── Odds do dia (paginadas) ─────────────────────────────────────────
    const oddsPorFixture = new Map();
    let pagina = 1, totalPaginas = 1;
    while (pagina <= totalPaginas && pagina <= MAX_PAGINAS_ODDS && candidatosPorFixture.size > 0) {
      const res = await fetchComRetry(
        `https://v3.football.api-sports.io/odds?date=${data}&bookmaker=${BOOKMAKER_ID}&page=${pagina}&timezone=America/Sao_Paulo`,
        { headers }, { timeoutMs: 15000 }
      );
      requestsGastos++;
      if (!res.ok) break; // triagem parcial > triagem nenhuma
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

    // ── Avaliação: TODOS os mercados de cada jogo ───────────────────────
    const candidatos = [];
    for (const [fid, j] of candidatosPorFixture) {
      const evento = `${j.timeA} vs ${j.timeB}`;
      const odds = oddsPorFixture.get(fid);
      if (!odds) {
        descartes.push({ evento, liga: j.liga, motivo: 'Sem odds publicadas ainda (Bet365)' });
        continue;
      }
      const avaliados = todasEstrategias(odds);
      if (!avaliados.length) {
        descartes.push({ evento, liga: j.liga, motivo: 'Odds publicadas não cobrem nenhum mercado das estratégias' });
        continue;
      }
      const dentro = avaliados.filter(e => e.margem >= -TOLERANCIA_MARGEM_PP);
      if (!dentro.length) {
        const melhor = avaliados.reduce((a, b) => (b.margem > a.margem ? b : a));
        descartes.push({
          evento, liga: j.liga,
          motivo: `Nenhum dos ${avaliados.length} mercados precificados entrou na tolerância (melhor: ${melhor.mercado}, ${melhor.margem.toFixed(1)}pp)`,
        });
        continue;
      }
      for (const e of dentro) {
        candidatos.push({
          fixtureId: fid,
          chave: `${fid}::${e.mercado}`,
          evento, timeA: j.timeA, timeB: j.timeB, liga: j.liga, hora: j.hora,
          mercado: e.mercado,
          probImplicita: Math.round(e.prob * 10) / 10,
          margem: Math.round(e.margem * 10) / 10,
          detalhe: e.detalhe,
        });
      }
    }

    // ── Seleção round-robin por mercado ─────────────────────────────────
    // Sem isso, ordenar tudo por margem faria um único mercado ocupar as
    // 40 vagas (foi o que aconteceu na v1 com "+0.5 Gols"). Aqui cada
    // rodada leva o melhor candidato AINDA NÃO escolhido de cada mercado,
    // seguindo ORDEM_MERCADOS — variedade garantida dentro do mesmo teto.
    const porMercado = new Map();
    for (const c of candidatos) {
      if (!porMercado.has(c.mercado)) porMercado.set(c.mercado, []);
      porMercado.get(c.mercado).push(c);
    }
    for (const lista of porMercado.values()) lista.sort((a, b) => b.margem - a.margem);

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

    // O que sobrou nas filas passou do teto — vira descarte com motivo
    // explícito de corte de cota, nunca "reprovado".
    for (const [mercado, fila] of porMercado) {
      for (const excedente of fila) {
        descartes.push({
          evento: excedente.evento, liga: excedente.liga,
          motivo: `Corte de cota — fora do teto de ${MAX_APTOS} análises (estava apto: ${mercado}, ${excedente.margem >= 0 ? '+' : ''}${excedente.margem}pp)`,
        });
      }
    }

    const resumoMercados = {};
    for (const a of aptos) resumoMercados[a.mercado] = (resumoMercados[a.mercado] || 0) + 1;

    const payload = {
      data,
      totalGrade,
      totalCandidatos: candidatos.length,
      resumoMercados,
      aptos,
      descartes,
      _requests: requestsGastos,
    };
    await setCached(chave, payload);
    return NextResponse.json(payload);
  } catch (e) {
    console.error(JSON.stringify({ etapa: 'scanner-triagem', data, erro: e.message }));
    return NextResponse.json({ error: 'Erro na triagem da grade.' }, { status: 500 });
  }
}
