export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getCached, setCached } from '@/lib/cache';
import { fetchComRetry } from '@/lib/fetchUtil';

// ─────────────────────────────────────────────────────────────────────────
// SCANNER DE GRADE — Estágio 1 (triagem barata)
//
// Objetivo: olhar a grade INTEIRA do dia gastando quase nada de cota
// (~1 chamada de fixtures + ~15-30 páginas de odds) e devolver:
//   - "aptos": jogos com pelo menos um mercado cuja probabilidade implícita
//     de-vigada fica ACIMA do score mínimo daquela estratégia — candidatos
//     que valem a análise completa (Gates 0-25 + IA), que custa 7-9
//     chamadas + 1 chamada de IA por jogo.
//   - "descartes": todo o resto, cada um com motivo auditável. Sem isso,
//     nunca dá pra responder "por que o scanner não pegou o jogo X?" — e
//     desconfiança em triagem que descarta em silêncio mata a ferramenta.
//
// A análise completa NÃO acontece aqui: o frontend (aba Scanner) recebe a
// lista de aptos e chama /api/analyze um por um, sequencialmente, com
// origem: 'scanner' — reusando o pipeline que já existe e já grava em
// analises_historico. Essa rota não escreve nada além de cache.
// ─────────────────────────────────────────────────────────────────────────

// 30 min: odds do dia mudam devagar de manhã; perto do kickoff o usuário
// pode forçar refresh (?refresh=1) se quiser a foto mais recente.
const CACHE_TTL_MS = 30 * 60 * 1000;

// Ligas onde a cobertura de dados da API-Football já se provou boa o
// bastante pros Gates (mesma lista priorizada em /api/jogos-do-dia). O
// scanner v1 SÓ considera essas — liga fora daqui é descartada com motivo.
// Racional: na análise manual o Gate 2 protege caso a caso; numa varredura
// em massa, gastar 8 chamadas por jogo pra descobrir que o dado é ruim
// inverte a lógica do funil (o estágio caro viraria o filtro). Pra ampliar
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
  40,                     // Championship (Inglaterra — volta cedo, início de agosto)
]);

// Teto de aptos por varredura. Protege a cota (40 × ~8 chamadas ≈ 320
// requests no estágio caro) e o tempo do loop no frontend (40 × ~10s ≈
// 7 min). Quem passa do corte NÃO é reprovado — é descartado com motivo
// explícito de corte, pra ficar claro que foi cota, não mérito.
const MAX_APTOS = 40;

// Tolerância da triagem, em pontos percentuais ABAIXO do mínimo da
// estratégia. Racional: exigir margem >= 0 (odd de mercado já acima do
// mínimo) seria MAIS rígido que o próprio pipeline — no /api/analyze o
// Gate 7 (essa mesma comparação) é informativo, não bloqueante. A zona
// logo abaixo do mínimo é justamente onde o dado real pode divergir do
// mercado a favor — cortar ela na porta mata a razão de existir da
// análise. 6pp é o ponto de partida; subir = mais aptos e mais cota
// gasta, descer = triagem mais dura. O corte de verdade continua sendo
// dos Gates 0-25 + IA no estágio caro.
const TOLERANCIA_MARGEM_PP = 6;

// Teto de páginas de odds (20 fixtures/página na API-Football). 30 páginas
// cobrem 600 jogos com odds — mais que qualquer grade real das ligas
// cobertas. Se estourar, os jogos sem odds carregadas caem em "sem odds".
const MAX_PAGINAS_ODDS = 30;

// bookmaker=8 (Bet365) — mesma referência de odds usada em buscarOddsReais
// do footballData.js, pra triagem e análise completa enxergarem o mesmo
// mercado e não divergirem entre estágios do funil.
const BOOKMAKER_ID = 8;

// Estratégias que a triagem consegue avaliar SÓ com odds (nome do mercado
// exatamente como em MERCADOS de /api/analyze — é o que o frontend repassa
// pro loop de análise). "min" replica o score mínimo daquele mercado: o
// Gate 7 do analyze compara probabilidade de-vigada com esse mesmo número,
// então a triagem usa a MESMA régua do funil — só que antes, e de graça.
// Mercados que exigem estatística (escanteios, 1º tempo) ficam de fora da
// triagem v1: odds não bastam pra pré-avaliá-los com honestidade.
const ESTRATEGIAS_TRIAGEM = {
  'Dupla Chance':   { min: 86 },
  'Lay Empate':     { min: 84 },
  '+1.5 Gols':      { min: 83 },
  '+0.5 Gols':      { min: 88 },
  'Under 3.5 Gols': { min: 85 },
  'BTTS Não':       { min: 88 },
};

// Probabilidade de-vigada de um par complementar (ex.: Over/Under da mesma
// linha): remove a margem da casa normalizando os inversos das odds.
function devigPar(oddA, oddB) {
  const a = 1 / oddA, b = 1 / oddB;
  return a / (a + b);
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 1 ? n : null;
}

// Extrai dos bets da Bet365 as odds que a triagem precisa. Retorna null nos
// campos ausentes — cada estratégia decide se consegue avaliar sem eles.
function extrairOdds(bets) {
  const porNome = {};
  for (const b of bets || []) porNome[b.name] = b.values || [];
  const valor = (bet, nome) =>
    num((porNome[bet] || []).find(v => String(v.value) === nome)?.odd);

  return {
    casa:    valor('Match Winner', 'Home'),
    empate:  valor('Match Winner', 'Draw'),
    fora:    valor('Match Winner', 'Away'),
    over05:  valor('Goals Over/Under', 'Over 0.5'),
    under05: valor('Goals Over/Under', 'Under 0.5'),
    over15:  valor('Goals Over/Under', 'Over 1.5'),
    under15: valor('Goals Over/Under', 'Under 1.5'),
    over35:  valor('Goals Over/Under', 'Over 3.5'),
    under35: valor('Goals Over/Under', 'Under 3.5'),
    bttsSim: valor('Both Teams Score', 'Yes'),
    bttsNao: valor('Both Teams Score', 'No'),
  };
}

// Avalia todas as estratégias possíveis com as odds disponíveis e devolve a
// MELHOR (maior margem = prob de-vigada × 100 − score mínimo do mercado).
// Um jogo é "apto" quando a melhor margem é >= 0: o próprio mercado de
// apostas precifica aquele desfecho acima do mínimo da estratégia — vale
// gastar a análise completa pra confirmar (ou derrubar) com dado real.
function melhorEstrategia(o) {
  const candidatas = [];

  if (o.casa && o.empate && o.fora) {
    const iC = 1 / o.casa, iE = 1 / o.empate, iF = 1 / o.fora;
    const s = iC + iE + iF;
    const pCasa = iC / s, pEmpate = iE / s, pFora = iF / s;
    const favoritoEmCasa = pCasa >= pFora;
    const pFavorito = favoritoEmCasa ? pCasa : pFora;

    candidatas.push({
      mercado: 'Dupla Chance',
      prob: (pFavorito + pEmpate) * 100,
      oddRef: favoritoEmCasa ? o.casa : o.fora,
      detalhe: favoritoEmCasa ? '1X (mandante não perde)' : 'X2 (visitante não perde)',
    });
    candidatas.push({
      mercado: 'Lay Empate',
      prob: (1 - pEmpate) * 100,
      oddRef: o.empate,
      detalhe: `odd do empate ${o.empate.toFixed(2)}`,
    });
  }
  if (o.over15 && o.under15) {
    candidatas.push({
      mercado: '+1.5 Gols',
      prob: devigPar(o.over15, o.under15) * 100,
      oddRef: o.over15, detalhe: `over 1.5 @ ${o.over15.toFixed(2)}`,
    });
  }
  if (o.over05 && o.under05) {
    candidatas.push({
      mercado: '+0.5 Gols',
      prob: devigPar(o.over05, o.under05) * 100,
      oddRef: o.over05, detalhe: `over 0.5 @ ${o.over05.toFixed(2)}`,
    });
  }
  if (o.under35 && o.over35) {
    candidatas.push({
      mercado: 'Under 3.5 Gols',
      prob: devigPar(o.under35, o.over35) * 100,
      oddRef: o.under35, detalhe: `under 3.5 @ ${o.under35.toFixed(2)}`,
    });
  }
  if (o.bttsNao && o.bttsSim) {
    candidatas.push({
      mercado: 'BTTS Não',
      prob: devigPar(o.bttsNao, o.bttsSim) * 100,
      oddRef: o.bttsNao, detalhe: `BTTS não @ ${o.bttsNao.toFixed(2)}`,
    });
  }

  if (!candidatas.length) return null;
  let melhor = null;
  for (const c of candidatas) {
    const margem = c.prob - ESTRATEGIAS_TRIAGEM[c.mercado].min;
    if (!melhor || margem > melhor.margem) melhor = { ...c, margem };
  }
  return melhor;
}

export async function GET(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const data = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const forcarRefresh = searchParams.get('refresh') === '1';

  const chave = `scanner-triagem::${data}`;
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
    // Reaproveita o cache da aba Jogos do Dia quando existir (mesma chave
    // usada em /api/jogos-do-dia) — economiza a chamada de fixtures inteira
    // se o usuário já abriu aquela aba hoje.
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
      // Só jogo que ainda não começou: o pipeline de análise inteiro (forma
      // recente, odds pré-jogo, Gates) assume estado pré-jogo.
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
    // Uma varredura só, filtrando no código pelos fixtures candidatos —
    // mais barato que 1 chamada de odds POR jogo, e a Bet365 cobre as
    // ligas da lista com folga.
    const oddsPorFixture = new Map();
    let pagina = 1, totalPaginas = 1;
    while (pagina <= totalPaginas && pagina <= MAX_PAGINAS_ODDS && candidatosPorFixture.size > 0) {
      const res = await fetchComRetry(
        `https://v3.football.api-sports.io/odds?date=${data}&bookmaker=${BOOKMAKER_ID}&page=${pagina}&timezone=America/Sao_Paulo`,
        { headers }, { timeoutMs: 15000 }
      );
      requestsGastos++;
      if (!res.ok) break; // triagem parcial > triagem nenhuma; jogos sem odds caem em descarte com motivo
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

    // ── Avaliação e corte ───────────────────────────────────────────────
    const aptos = [];
    for (const [fid, j] of candidatosPorFixture) {
      const evento = `${j.timeA} vs ${j.timeB}`;
      const odds = oddsPorFixture.get(fid);
      if (!odds) {
        descartes.push({ evento, liga: j.liga, motivo: 'Sem odds publicadas ainda (Bet365)' });
        continue;
      }
      const melhor = melhorEstrategia(odds);
      if (!melhor) {
        descartes.push({ evento, liga: j.liga, motivo: 'Odds publicadas não cobrem nenhum mercado das estratégias' });
        continue;
      }
      if (melhor.margem < -TOLERANCIA_MARGEM_PP) {
        descartes.push({
          evento, liga: j.liga,
          motivo: `Melhor mercado (${melhor.mercado}) precificado ${Math.abs(melhor.margem).toFixed(1)}pp abaixo do mínimo — fora da tolerância de ${TOLERANCIA_MARGEM_PP}pp da triagem`,
        });
        continue;
      }
      aptos.push({
        fixtureId: fid,
        evento,
        timeA: j.timeA,
        timeB: j.timeB,
        liga: j.liga,
        hora: j.hora,
        mercado: melhor.mercado,
        probImplicita: Math.round(melhor.prob * 10) / 10,
        margem: Math.round(melhor.margem * 10) / 10,
        detalhe: melhor.detalhe,
      });
    }

    aptos.sort((a, b) => b.margem - a.margem);
    for (const excedente of aptos.slice(MAX_APTOS)) {
      descartes.push({
        evento: excedente.evento, liga: excedente.liga,
        motivo: `Corte de cota — fora do top ${MAX_APTOS} por margem (estava apto: ${excedente.mercado}, +${excedente.margem}pp)`,
      });
    }

    const payload = {
      data,
      totalGrade,
      aptos: aptos.slice(0, MAX_APTOS),
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
