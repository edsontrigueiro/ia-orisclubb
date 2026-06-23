export const dynamic = 'force-dynamic';
// Sem isso, a Vercel mata a função no limite padrão (10s no plano Hobby)
// antes mesmo do nosso próprio timeout da chamada à Anthropic ter chance
// de terminar. 60s é o máximo permitido no plano Hobby.
export const maxDuration = 60;
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getCached, setCached } from '@/lib/cache';

// Log estruturado: facilita achar no Vercel exatamente em qual etapa e
// confronto algo falhou, em vez de só um texto solto sem contexto.
function logErro(etapa, contexto, erro) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    etapa,
    ...contexto,
    erro: erro?.message || String(erro),
  }));
}

// Retentativa simples para erros transitórios (rate limit / instabilidade
// momentânea da API). Não tenta de novo em erros definitivos (404, 401 etc).
// timeoutMs é recriado a cada tentativa — passar um "signal" já pronto no
// opts faria o cronômetro do timeout começar a contar ANTES da 1ª tentativa
// e continuar contando durante o retry, fazendo a 2ª tentativa abortar
// quase instantaneamente se a 1ª já tiver demorado perto do limite.
async function fetchComRetry(url, opts = {}, { tentativas = 2, timeoutMs = 8000 } = {}) {
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

// Cache de análises já feitas, TTL de 2h, pra não gastar chamada de
// API-Football/Anthropic repetindo o mesmo confronto+mercado em sequência.
// Prefixo "analise::" evita colidir com outras chaves de cache (ex: a grade
// de jogos do dia, que usa o mesmo armazenamento compartilhado).
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

function chaveCache(jogo, mercado) {
  return `analise::${jogo.trim().toLowerCase()}::${mercado}`;
}

async function lerCache(jogo, mercado) {
  return getCached(chaveCache(jogo, mercado), CACHE_TTL_MS);
}

async function salvarCache(jogo, mercado, payload) {
  return setCached(chaveCache(jogo, mercado), payload);
}

const MERCADOS = {
  'Lay 2x2':        { min: 82 },
  'Dupla Chance':   { min: 86 },
  '+1.5 Gols':      { min: 83 },
  '+0.5 Gols':      { min: 88 },
  'Tênis':          { min: 84 },
  '-2.5 Gols 1T':   { min: 86 },
  'Lay Empate':     { min: 84 },
  'Under 3.5 Gols': { min: 85 },
};

// Critérios estatísticos explícitos por mercado, injetados no prompt da IA
// para os mercados de alta assertividade. Sem isso, a IA julga "no genérico"
// e o score deixa de refletir os sinais que de fato tornam esses mercados
// historicamente mais assertivos.
const CRITERIOS_MERCADO = {
  'Dupla Chance': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Dupla Chance (1X ou X2) no favorito:
- Só aprove se houver diferença CLARA de qualidade entre os times nos dados: favorito com média de gols marcados >= 1.8 e média de gols sofridos <= 1.2; adversário com média de gols sofridos >= 1.5. Se as médias forem parecidas entre os dois times, isso é um jogo equilibrado — REPROVE, mesmo que um dos nomes "pareça" favorito.
- Priorize "como_mandante" do Time A e "como_visitante" do Time B (não a média geral) — um time pode ser ótimo em casa e mediano fora, e é justamente o mando de campo que decide esse mercado. EXCEÇÃO: se "modo_copa" for true (torneio internacional, possivelmente em sede neutra), esse mando pode não refletir uma vantagem real de jogar "em casa" — nesse caso baseie-se na forma geral combinada em vez de insistir no recorte mandante/visitante.
- Nos confrontos diretos disponíveis (até 10), o favorito não deve ter mais de 1 derrota — dê peso extra aos confrontos com "mesmo_mando_atual": true. 2+ derrotas no H2H é sinal de zebra recorrente — reduza o score fortemente.
- Exija amostra mínima de 8 jogos disputados na temporada para AMBOS os times. Menos que isso, reduza o score e diga isso explicitamente em "alertas".
- Competições eliminatórias / mata-mata (decisão, copa, playoff) têm motivação anormal e mais risco de zebra — se a "liga" indicada nos dados for desse tipo, reduza o score mesmo com favoritismo claro nas médias.`,

  'Lay Empate': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Lay Empate (o jogo não pode terminar em X):
- Só aprove se a soma das médias de gols marcados dos dois times for >= 2.4. Jogos com tendência ofensiva clara empatam menos.
- Nos confrontos diretos disponíveis (até 10), no máximo 2 podem ter terminado empatados. 3+ empates no H2H é sinal forte de que esse confronto específico tende ao empate — reprove.
- Prefira confrontos com diferença de qualidade clara (favorito x zebra). Jogos historicamente equilibrados entre os mesmos dois times tendem a empate; isso deve reduzir o score mesmo se a soma de gols for alta.
- Exija amostra mínima de 8 jogos disputados na temporada para AMBOS os times.`,

  'Under 3.5 Gols': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Under 3.5 Gols (jogo total com 3 gols ou menos):
- Só aprove se a soma das médias de gols marcados dos dois times for <= 2.6.
- Exija que pelo menos um dos dois times tenha taxa de "jogos sem sofrer gol" (clean sheets / jogos disputados) >= 25%. Isso indica capacidade defensiva real, não só sorte pontual.
- Nos confrontos diretos disponíveis (até 10), a média de gols totais por jogo deve ser <= 3.0. Histórico de jogos com 4+ gols entre esses times específicos é motivo forte para reprovar, mesmo com médias de temporada baixas.
- Exija amostra mínima de 8 jogos disputados na temporada para AMBOS os times.`,

  '-2.5 Gols 1T': `CRITÉRIOS DE ALTA ASSERTIVIDADE — Under 2.5 Gols no PRIMEIRO TEMPO (total de gols dos dois times até o intervalo <= 2):
- Esse mercado é especificamente sobre o 1º TEMPO, não o jogo todo. Use o subcampo "primeiro_tempo" dentro de "forma_recente_time_a/b" — ele já vem calculado a partir do placar real do intervalo de cada jogo, NÃO é estimado a partir da média do jogo inteiro. Se "primeiro_tempo" for null, a API não trouxe placar de intervalo pra esses jogos — isso é ESPERADO e comum em jogos de seleção nacional (amistosos, eliminatórias), onde a cobertura de dado é mais pobre que em ligas de clube europeias; diga isso explicitamente no insight ("cobertura de dado de 1º tempo é tipicamente mais pobre pra jogos de seleção") em vez de tratar como uma falha genérica qualquer. Reduza a confiança mesmo assim, mas tente usar "pct_jogos_1t_total_baixo" quando disponível.
- "primeiro_tempo.pct_jogos_1t_total_baixo" de cada time é a métrica mais direta pra esse mercado: é o % dos jogos recentes desse time em que o total de gols no 1T (somando os dois lados) foi <= 2. Só aprove se os dois times tiverem esse percentual >= 60%.
- Em "confrontos_diretos", use o campo "placar_1t" quando presente — H2H com 1T historicamente movimentado (2+ gols no intervalo) entre esses dois times específicos é motivo forte pra reprovar, mesmo com boas médias gerais.
- Times que costumam "começar devagar" (média de gols marcados no 1T bem menor que a média do jogo completo) favorecem esse mercado — compare "media_gols_marcados_1t" com "media_gols_marcados" geral pra notar esse padrão.
- Exija amostra mínima de 8 jogos com dado de 1º tempo disponível pra AMBOS os times.`,
};

function demoResult(jogo, mercado, motivo) {
  const min = MERCADOS[mercado]?.min || 82;
  const score = min + Math.floor(Math.random() * 15);
  const motivoFinal = motivo || 'Configure ANTHROPIC_API_KEY para análise real';
  return {
    evento: jogo,
    competicao: 'Modo Demo',
    score,
    aprovado: score >= min,
    odds_estimada: '1.20',
    probabilidade_real: 72 + Math.floor(Math.random() * 18),
    criterios_atendidos: ['H2H favorável', 'Forma recente positiva'],
    criterios_nao_atendidos: [],
    alertas: [motivoFinal],
    insight: `Análise em modo demonstração. ${motivoFinal}.`,
    resumo: `Resultado simulado, não use pra decisão real. Motivo: ${motivoFinal}.`,
    _minScore: min,
    _demo: true,
  };
}

function parseTimes(jogo) {
  // Aceita "vs", "vs." (com ponto) e "x" como separador — "vs." sem o ponto
  // opcional no regex fazia o split falhar silenciosamente, tratando o jogo
  // inteiro como um único nome de time e o segundo como ausente.
  const partes = jogo.split(/\s+vs\.?\s+|\s+x\s+/i);
  return {
    timeA: partes[0]?.trim().replace(/[.,]+$/, '') || null,
    timeB: partes[1]?.trim().replace(/[.,]+$/, '') || null,
  };
}

async function buscarIdTime(nome, headers) {
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(nome)}`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const candidatos = data?.response || [];
    if (candidatos.length === 0) return null;

    // A API retorna por ordem de relevância interna, que nem sempre é a
    // seleção/clube certo (ex: pode vir um clube com nome parecido antes da
    // seleção nacional). Prioriza nome exatamente igual (case-insensitive);
    // se não houver, cai pro primeiro resultado como antes.
    const alvo = nome.trim().toLowerCase();
    const exato = candidatos.find(c => c.team?.name?.trim().toLowerCase() === alvo);
    return (exato || candidatos[0])?.team?.id || null;
  } catch (e) {
    logErro('buscarIdTime', { nome }, e);
    return null;
  }
}

async function buscarProximoJogo(teamId, headers) {
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/fixtures?team=${teamId}&next=1`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      const proximo = data?.response?.[0];
      if (proximo) return proximo;
    }
    // Sem próximo jogo agendado (time fora de temporada, eliminado, etc.) —
    // usa o último jogo já disputado pra ainda ter liga/temporada válidas
    // pra puxar estatísticas, em vez de desistir e deixar tudo nulo.
    const resUltimo = await fetchComRetry(
      `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=1`,
      { headers }
    );
    if (!resUltimo.ok) return null;
    const dataUltimo = await resUltimo.json();
    return dataUltimo?.response?.[0] || null;
  } catch (e) {
    logErro('buscarProximoJogo', { teamId }, e);
    return null;
  }
}

async function buscarHeadToHead(idA, idB, headers) {
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${idA}-${idB}&last=10`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.response || null;
  } catch (e) {
    logErro('buscarHeadToHead', { idA, idB }, e);
    return null;
  }
}

// Acha o jogo EXATO entre os dois times que está por vir (não o próximo
// jogo de qualquer um deles isolado — esse precisa ser especificamente A x
// B), pra poder buscar a odd real DESSE confronto e identificar a
// competição exata em que ele está sendo disputado (não a próxima
// competição genérica de cada time isolado, que pode ser outra).
async function buscarFixtureFuturo(idA, idB, headers) {
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${idA}-${idB}&next=1`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const f = data?.response?.[0];
    if (!f) return null;
    return {
      id: f.fixture?.id || null,
      ligaNome: f.league?.name || null,
      round: f.league?.round || null,
    };
  } catch (e) {
    logErro('buscarFixtureFuturo', { idA, idB }, e);
    return null;
  }
}

// Liga/copa têm estrutura estatística DIFERENTE: em liga doméstica os
// mesmos dois times se enfrentam todo ano (H2H rico) e mando de campo é
// estável; em copa/mata-mata (Copa do Mundo, Libertadores, Champions,
// Copa do Brasil) o confronto entre exatamente esses dois times pode ser
// raro ou inédito, e em torneios internacionais o jogo às vezes nem tem
// mando de campo real (sede neutra). H2H ausente numa copa não é "falta
// de dado" — é o normal estrutural. Detecta isso por palavras do "round"
// (fase de grupos, oitavas, etc. só existem em copa) e pelo nome da liga.
function ehCompeticaoDeCopa(round, ligaNome) {
  const texto = `${round || ''} ${ligaNome || ''}`.toLowerCase();
  const padraoCopa = /group stage|grupo|round of|oitavas|quartas|quarter|semi|final|knockout|playoff|preliminary|qualif|copa|cup|champions|libertadores|sudamericana|mundial|world cup/i;
  const padraoLiga = /regular season|apertura|clausura/i;
  if (padraoLiga.test(texto) && !padraoCopa.test(texto)) return false;
  return padraoCopa.test(texto);
}

// Mapa de mercado interno -> nome do mercado de odds na API-Football e qual
// "value" extrair. Só mercados com correspondência INEQUÍVOCA com um mercado
// padrão de casa de apostas entram aqui — "Lay 2x2" e "Lay Empate" não têm
// equivalente direto e ambíguo seria pior que não comparar.
const ODDS_MAPA = {
  '+1.5 Gols':      { bet: 'Goals Over/Under', value: 'Over 1.5' },
  '+0.5 Gols':      { bet: 'Goals Over/Under', value: 'Over 0.5' },
  'Under 3.5 Gols': { bet: 'Goals Over/Under', value: 'Under 3.5' },
  'Dupla Chance':   { bet: 'Double Chance', value: null }, // valor varia conforme quem é o favorito, tratado abaixo
};

// Busca a odd real de mercado pro confronto, se o plano da API-Football
// cobrir o endpoint /odds. Se não cobrir (403/erro) ou não achar o mercado
// específico na resposta, retorna null silenciosamente — nunca trava a
// análise por causa disso, é só um dado extra quando disponível.
async function buscarOddsReais(fixtureId, mercado, headers) {
  const mapa = ODDS_MAPA[mercado];
  if (!fixtureId || !mapa) return null;
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/odds?fixture=${fixtureId}`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const bookmakers = data?.response?.[0]?.bookmakers || [];
    if (bookmakers.length === 0) return null;

    // Double Chance: devolve as duas opções relevantes (Home/Draw e
    // Draw/Away) e deixa a IA decidir qual bate com o favorito que ELA
    // identificou — o código não sabe ainda quem é favorito nesse ponto.
    if (mapa.bet === 'Double Chance') {
      const valores = { 'Home/Draw': [], 'Draw/Away': [] };
      for (const bm of bookmakers) {
        const aposta = bm.bets?.find(b => b.name === 'Double Chance');
        for (const v of (aposta?.values || [])) {
          if (valores[v.value]) valores[v.value].push(parseFloat(v.odd));
        }
      }
      const media = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
      const homeDraw = media(valores['Home/Draw']);
      const drawAway = media(valores['Draw/Away']);
      if (homeDraw == null && drawAway == null) return null;
      return { mercado, odd_1x_time_a: homeDraw, odd_x2_time_b: drawAway, casas_consultadas: bookmakers.length };
    }

    // Goals Over/Under: pega a média da odd pro valor específico (ex:
    // "Over 1.5") entre todas as casas que oferecem esse mercado.
    const valores = [];
    for (const bm of bookmakers) {
      const aposta = bm.bets?.find(b => b.name === mapa.bet);
      const v = aposta?.values?.find(v => v.value === mapa.value);
      if (v) valores.push(parseFloat(v.odd));
    }
    if (valores.length === 0) return null;
    return {
      mercado,
      valor: mapa.value,
      odd_media: +(valores.reduce((a, b) => a + b, 0) / valores.length).toFixed(2),
      casas_consultadas: valores.length,
    };
  } catch (e) {
    logErro('buscarOddsReais', { fixtureId, mercado }, e);
    return null;
  }
}

// Agrega uma lista de jogos (já filtrada) na perspectiva de um time
// específico — usado pra forma geral, só em casa, só fora, e últimos 5.
function agregarJogos(jogos, teamId) {
  let vitorias = 0, empates = 0, derrotas = 0;
  let golsMarcados = 0, golsSofridos = 0;
  let semSofrer = 0, semMarcar = 0, validos = 0;
  // 1º tempo: a API já manda o placar do intervalo em "score.halftime" de
  // cada jogo — só nunca tínhamos extraído. Sem isso, mercados como "-2.5
  // Gols 1T" não tinham nenhum dado real de 1º tempo pra se basear.
  let golsMarcados1T = 0, golsSofridos1T = 0, validos1T = 0, jogos1TBaixo = 0;

  for (const f of jogos) {
    const ehCasa = f.teams?.home?.id === teamId;
    const golsPro = ehCasa ? f.goals?.home : f.goals?.away;
    const golsContra = ehCasa ? f.goals?.away : f.goals?.home;
    if (golsPro == null || golsContra == null) continue;
    validos++;
    golsMarcados += golsPro;
    golsSofridos += golsContra;
    if (golsContra === 0) semSofrer++;
    if (golsPro === 0) semMarcar++;
    if (golsPro > golsContra) vitorias++;
    else if (golsPro === golsContra) empates++;
    else derrotas++;

    const ht = f.score?.halftime;
    const golsPro1T = ehCasa ? ht?.home : ht?.away;
    const golsContra1T = ehCasa ? ht?.away : ht?.home;
    if (golsPro1T != null && golsContra1T != null) {
      validos1T++;
      golsMarcados1T += golsPro1T;
      golsSofridos1T += golsContra1T;
      if (golsPro1T + golsContra1T <= 2) jogos1TBaixo++;
    }
  }
  if (validos === 0) return null;

  return {
    jogos_considerados: validos,
    vitorias, empates, derrotas,
    media_gols_marcados: +(golsMarcados / validos).toFixed(2),
    media_gols_sofridos: +(golsSofridos / validos).toFixed(2),
    jogos_sem_sofrer_gol: semSofrer,
    jogos_sem_marcar_gol: semMarcar,
    // Específico pro mercado de gols no 1º tempo — null se a API não trouxe
    // o placar do intervalo pra nenhum desses jogos (raro, mas acontece em
    // ligas menores).
    primeiro_tempo: validos1T === 0 ? null : {
      jogos_considerados: validos1T,
      media_gols_marcados_1t: +(golsMarcados1T / validos1T).toFixed(2),
      media_gols_sofridos_1t: +(golsSofridos1T / validos1T).toFixed(2),
      // % dos jogos desse time em que o total de gols no 1T (dos dois lados)
      // foi <= 2 — é literalmente a pergunta que o mercado "-2.5 Gols 1T" faz.
      pct_jogos_1t_total_baixo: +((jogos1TBaixo / validos1T) * 100).toFixed(0),
    },
  };
}

// Estatísticas via /teams/statistics ficam PRESAS à liga+temporada do
// próximo jogo. Em torneios recém-iniciados (ex: fase de grupos de Copa do
// Mundo), isso reduz a amostra a 1-2 jogos mesmo que o time tenha dezenas de
// partidas recentes em eliminatórias/amistosos. Esta função busca os últimos
// jogos do time SEM esse travamento de competição, pra servir de base mais
// robusta quando a amostra "presa" à competição atual for pequena.
async function buscarFormaRecente(teamId, headers, qtd = 10) {
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/fixtures?team=${teamId}&last=${qtd}`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const jogos = (data?.response || [])
      .filter(f => f.fixture?.status?.short === 'FT')
      // Mais recente primeiro — garante que "últimos 5" sejam de fato os 5
      // mais recentes, independente da ordem que a API devolveu.
      .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date));
    if (jogos.length === 0) return null;

    const mandante = jogos.filter(f => f.teams?.home?.id === teamId);
    const visitante = jogos.filter(f => f.teams?.away?.id === teamId);

    return {
      // Geral: todos os jogos buscados, casa+fora misturados.
      ...agregarJogos(jogos, teamId),
      // Só em casa / só fora — efeito de mando de campo é real e relevante.
      como_mandante: agregarJogos(mandante, teamId),
      como_visitante: agregarJogos(visitante, teamId),
      // Últimos 5 (subconjunto dos mesmos jogos, já ordenados do mais
      // recente) — serve pra detectar mudança de momento vs. os últimos 10.
      ultimos_5: agregarJogos(jogos.slice(0, 5), teamId),
    };
  } catch (e) {
    logErro('buscarFormaRecente', { teamId }, e);
    return null;
  }
}

async function buscarEstatisticasTime(teamId, leagueId, season, headers) {
  if (!leagueId || !season) return null;
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/teams/statistics?team=${teamId}&league=${leagueId}&season=${season}`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const s = data?.response;
    if (!s || !s.fixtures) return null;
    return {
      jogos_disputados: s.fixtures?.played?.total ?? null,
      vitorias: s.fixtures?.wins?.total ?? null,
      empates: s.fixtures?.draws?.total ?? null,
      derrotas: s.fixtures?.loses?.total ?? null,
      media_gols_marcados: s.goals?.for?.average?.total ?? null,
      media_gols_sofridos: s.goals?.against?.average?.total ?? null,
      jogos_sem_sofrer_gol: s.clean_sheet?.total ?? null,
      jogos_sem_marcar_gol: s.failed_to_score?.total ?? null,
    };
  } catch (e) {
    logErro('buscarEstatisticasTime', { teamId, leagueId, season }, e);
    return null;
  }
}

// Monta um pacote de dados reais sobre o confronto. Retorna sempre um objeto
// explícito indicando o que foi possível obter, para o prompt nunca tratar
// dado ausente como dado real.
async function getFootballData(jogo, mercado) {
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) {
    return { disponivel: false, motivo: 'FOOTBALL_API_KEY não configurada.' };
  }
  const headers = { 'x-apisports-key': key };

  const { timeA, timeB } = parseTimes(jogo);
  if (!timeA || !timeB) {
    return { disponivel: false, motivo: 'Não foi possível identificar os dois times no texto informado (use "Time A vs Time B").' };
  }

  const [idA, idB] = await Promise.all([
    buscarIdTime(timeA, headers),
    buscarIdTime(timeB, headers),
  ]);

  if (!idA || !idB) {
    const faltando = !idA ? timeA : timeB;
    return { disponivel: false, motivo: `Time "${faltando}" não encontrado na base da API-Football.` };
  }

  // Cada time tem sua própria liga/temporada — times de confederações ou
  // campeonatos diferentes (comum em amistosos de seleções) não podem
  // compartilhar o mesmo contexto de liga, ou a busca de estatísticas do
  // outro time simplesmente não acha nada.
  const [proximoJogoA, proximoJogoB] = await Promise.all([
    buscarProximoJogo(idA, headers),
    buscarProximoJogo(idB, headers),
  ]);
  const leagueIdA = proximoJogoA?.league?.id || null;
  const seasonA = proximoJogoA?.league?.season || null;
  const leagueIdB = proximoJogoB?.league?.id || null;
  const seasonB = proximoJogoB?.league?.season || null;

  const [h2h, statsA, statsB, formaA, formaB, fixtureFuturo] = await Promise.all([
    buscarHeadToHead(idA, idB, headers),
    buscarEstatisticasTime(idA, leagueIdA, seasonA, headers),
    buscarEstatisticasTime(idB, leagueIdB, seasonB, headers),
    buscarFormaRecente(idA, headers),
    buscarFormaRecente(idB, headers),
    buscarFixtureFuturo(idA, idB, headers),
  ]);

  const oddsReais = ODDS_MAPA[mercado]
    ? await buscarOddsReais(fixtureFuturo?.id, mercado, headers)
    : null;

  // Prioriza a competição do confronto EXATO (achado via H2H) pra decidir
  // se é modo copa; se não achou esse confronto específico (ex: chaveamento
  // ainda não definido), usa o próximo jogo do time A como aproximação.
  const modoCopa = fixtureFuturo
    ? ehCompeticaoDeCopa(fixtureFuturo.round, fixtureFuturo.ligaNome)
    : ehCompeticaoDeCopa(proximoJogoA?.league?.round, proximoJogoA?.league?.name);

  const h2hResumido = (h2h || [])
    .slice(0, 10)
    .sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date))
    .map(f => ({
      data: f.fixture?.date,
      // Calculado aqui no servidor, não deixado pra IA inferir da data —
      // tirar a IA de fazer aritmética de datas evita erro bobo e deixa a
      // instrução de "pesar o mais recente" objetiva e verificável.
      dias_atras: f.fixture?.date ? Math.round((Date.now() - new Date(f.fixture.date).getTime()) / 86400000) : null,
      casa: f.teams?.home?.name,
      fora: f.teams?.away?.name,
      placar: `${f.goals?.home ?? '?'}-${f.goals?.away ?? '?'}`,
      placar_1t: f.score?.halftime?.home != null
        ? `${f.score.halftime.home}-${f.score.halftime.away}`
        : null,
      // Indica se nesse confronto passado o mando de campo foi o mesmo do
      // jogo analisado agora (time A em casa) — confronto direto com o mesmo
      // mando vale mais como sinal do que um com os lados invertidos.
      mesmo_mando_atual: f.teams?.home?.id === idA,
    }));

  return {
    disponivel: true,
    time_a: timeA,
    time_b: timeB,
    liga_time_a: proximoJogoA?.league?.name || null,
    liga_time_b: proximoJogoB?.league?.name || null,
    temporada_time_a: seasonA,
    temporada_time_b: seasonB,
    // true = competição de copa/mata-mata (Copa do Mundo, Libertadores,
    // Champions, Copa do Brasil etc.) — nessas, H2H raro/ausente e amostra
    // pequena NA competição atual são NORMAIS, não falha de dado. Ver
    // regra correspondente no prompt.
    modo_copa: modoCopa,
    confrontos_diretos: h2hResumido.length ? h2hResumido : null,
    confrontos_diretos_indisponivel: h2hResumido.length === 0,
    // Estatísticas presas à competição/temporada do próximo jogo — útil
    // quando o time já tem amostra grande NESSA competição específica.
    estatisticas_time_a: statsA,
    estatisticas_time_b: statsB,
    estatisticas_indisponiveis: !statsA && !statsB,
    // Forma recente — últimos jogos do time em QUALQUER competição. Use como
    // base principal quando "estatisticas_time_a/b" tiver amostra pequena
    // (ex: torneio recém-iniciado), pois reflete o nível atual do time com
    // muito mais jogos de apoio.
    forma_recente_time_a: formaA,
    forma_recente_time_b: formaB,
    forma_recente_indisponivel: !formaA && !formaB,
    // Odd real de mercado (se o plano da API-Football cobrir /odds e o
    // mercado tiver mapeamento — ver ODDS_MAPA). Quando ausente, é só falta
    // de cobertura/dados, não falha — a IA segue estimando como antes.
    odds_mercado_real: oddsReais,
  };
}

function montarSystemPrompt() {
  return `Você é um analista estatístico de apostas esportivas, rigoroso e conservador. Siga estas regras de forma inegociável:

1. Use SOMENTE os dados fornecidos no bloco "DADOS" abaixo. Nunca invente médias, placares de confrontos diretos, ou estatísticas que não estejam explicitamente presentes nos dados.
2. Se um campo de dados estiver nulo, ausente, ou marcado como indisponível, trate-o como informação que você NÃO TEM — não preencha com suposição genérica.
3. Quanto menos dados reais disponíveis, menor deve ser o "score" e o "probabilidade_real", e isso deve ser explicado em "alertas". Análise sem dados suficientes deve tender a "aprovado": false.
4. Os campos "criterios_atendidos" e "criterios_nao_atendidos" devem citar números concretos vindos dos dados (ex: "média de 1.8 gols marcados em 10 jogos"), nunca frases vagas como "boa forma" sem número de apoio.
5. Se os dados estiverem totalmente indisponíveis, diga isso claramente no "insight" e no "resumo", e ainda assim responda apenas com o JSON pedido.
6. Se a mensagem do usuário incluir um bloco "CRITÉRIOS ESPECÍFICOS DESTE MERCADO", esses critérios têm prioridade sobre seu julgamento genérico. Eles definem exatamente o que torna esse mercado estatisticamente confiável — verifique cada condição explicitamente contra os dados e cite no "criterios_atendidos"/"criterios_nao_atendidos" quais delas foram ou não satisfeitas, com o número real que comprova. Se uma condição obrigatória desses critérios não for satisfeita, o score deve cair abaixo do mínimo, independentemente de outros sinais favoráveis.
7. Os dados trazem duas fontes de estatística por time: "estatisticas_time_a/b" (presa à competição/temporada do próximo jogo do time) e "forma_recente_time_a/b" (últimos jogos do time em qualquer competição). Se "estatisticas_time_a/b" tiver amostra pequena (jogos_disputados <= 2) ou estiver nula, use "forma_recente_time_a/b" como base principal da análise — ela tem mais jogos de apoio e reflete melhor o nível atual do time. Cite explicitamente qual das duas fontes você usou e por quê.
8. Convenção do confronto: no formato "Time A vs Time B", Time A é o mandante (joga em casa) e Time B é o visitante nesse jogo específico. "forma_recente_time_a/b" traz subcampos "como_mandante" e "como_visitante" — priorize "como_mandante" do Time A e "como_visitante" do Time B sobre a média geral misturada, pois mando de campo é um efeito real no futebol. Em "confrontos_diretos", dê mais peso aos jogos com "mesmo_mando_atual": true (mesmo mando de campo do confronto atual) do que aos com mando invertido. Se "ultimos_5" divergir muito de "ultimos_10"/geral (ex: time que vinha bem mas piorou nos últimos 5, ou vice-versa), trate isso como mudança de momento e mencione explicitamente no "insight" — não ignore a tendência recente em favor só da média.
9. Em "confrontos_diretos", cada item já vem com "dias_atras" calculado. Pese MUITO mais os confrontos com menos de ~365 dias do que os mais antigos — times mudam de elenco, técnico e nível de um ano pro outro, então um 5-0 de 3 anos atrás não diz quase nada sobre o jogo de hoje. Se a maioria dos confrontos diretos disponíveis tiver mais de 2 anos (730 dias), trate o H2H como pouco confiável e diga isso no "insight", em vez de usá-lo com o mesmo peso de um H2H recente.
10. Se "odds_mercado_real" estiver presente, é a odd REAL cotada pelo mercado de apostas pra esse confronto específico (média entre casas) — não uma estimativa. Compare com a "probabilidade_real" que você calculou: se sua probabilidade implica uma odd "justa" bem menor que a odd real oferecida (ex: você calcula 85% de chance, que equivale a odd justa ~1.18, mas o mercado paga 1.35), isso é sinal de valor — mencione no "resumo". Se a odd real estiver MENOR do que sua probabilidade justificaria, isso é sinal de que o mercado está "caro" pra esse lado — também mencione. Use o campo "odds_estimada" pra sua própria estimativa de qualquer forma; quando "odds_mercado_real" existir, cite o número real explicitamente no "insight" também, não só o seu.
11. Se "modo_copa" for true, esse confronto é de uma competição de copa/mata-mata (Copa do Mundo, Libertadores, Champions, Copa do Brasil, etc.), e isso muda o que conta como "dado insuficiente":
    - "confrontos_diretos_indisponivel": true em modo copa é NORMAL — times de chaves/grupos/confederações diferentes raramente ou nunca se enfrentaram antes. NÃO reduza o score só por isso, como faria numa liga doméstica. Só penalize H2H ausente se outras fontes de dado TAMBÉM estiverem fracas.
    - "estatisticas_time_a/b" com amostra pequena (poucos jogos NESSA edição específica do torneio) também é normal, principalmente em fases iniciais. Em modo copa, prefira SEMPRE "forma_recente_time_a/b" como base principal, com confiança normal — não trate a ausência de estatística "presa ao torneio" como um problema a mais.
    - Mando de campo é menos confiável em modo copa, especialmente torneios internacionais de seleções em sede neutra (nem A nem B jogam "em casa" de fato). Dê menos peso a "como_mandante"/"como_visitante" e mais à forma geral combinada, a menos que fique claro pelos dados que um dos times é o anfitrião do torneio.
    - Resumindo: em modo copa, julgue principalmente pela "forma_recente" geral de cada time e pelo "ultimos_5" — não reprove automaticamente só porque H2H e estatísticas do torneio estão vazios, isso é esperado nesse contexto.

Responda SOMENTE com JSON válido, sem markdown, sem texto fora do JSON.`;
}

export async function POST(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  // Capturados aqui fora, antes do try, porque request.clone() falha com
  // "unusable" se chamado depois que o body já foi lido — então o fallback
  // de erro não pode depender de reconstruir a request lá no catch.
  let jogo, mercado;

  try {
    ({ jogo, mercado } = await request.json());
    if (!jogo || !mercado)
      return NextResponse.json({ error: 'Jogo e mercado obrigatórios.' }, { status: 400 });
    if (!MERCADOS[mercado])
      return NextResponse.json({ error: 'Mercado inválido.' }, { status: 400 });

    // Cache: mesmo jogo+mercado analisado há menos de 2h devolve na hora,
    // sem gastar chamada de API-Football nem de IA de novo.
    const cacheado = await lerCache(jogo, mercado);
    if (cacheado) return NextResponse.json({ ...cacheado, _cache: true });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json(demoResult(jogo, mercado));

    const min = MERCADOS[mercado].min;
    const dadosReais = await getFootballData(jogo, mercado);

    const blocoDados = dadosReais.disponivel
      ? `DADOS:\n${JSON.stringify(dadosReais)}`
      : `DADOS: indisponíveis. Motivo: ${dadosReais.motivo}`;

    const blocoCriterios = CRITERIOS_MERCADO[mercado]
      ? `\n\n${CRITERIOS_MERCADO[mercado]}`
      : '';

    const res = await fetchComRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: montarSystemPrompt(),
        messages: [{
          role: 'user',
          content: `Analise "${jogo}" para o mercado "${mercado}". Score mínimo para aprovar: ${min}/100.
${blocoCriterios}

${blocoDados}

Responda SOMENTE JSON válido sem markdown, neste formato exato:
{"evento":"nome formatado","competicao":"liga ou null","score":0-100,"aprovado":bool,"odds_estimada":"1.XX","probabilidade_real":0-100,"criterios_atendidos":["..."],"criterios_nao_atendidos":["..."],"alertas":[],"insight":"frase curta explicando o score, citando dado real se houver","resumo":"2-3 frases operacionais para o trader"}`
        }]
      }),
    }, { tentativas: 1, timeoutMs: 50000 });

    if (!res.ok) {
      logErro('anthropic_call', { jogo, mercado, status: res.status }, await res.text().catch(() => 'sem corpo'));
      return NextResponse.json(demoResult(jogo, mercado, `A IA não respondeu corretamente (status ${res.status}). Tente novamente em alguns minutos.`));
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.replace(/```json|```/g, '').trim();
    if (!text) return NextResponse.json(demoResult(jogo, mercado, 'A IA não retornou conteúdo válido. Tente novamente.'));

    const result = JSON.parse(text);
    result._minScore = min;
    result._dadosReaisUsados = dadosReais.disponivel;
    result._oddsReais = dadosReais.odds_mercado_real || null;

    // Só cacheia análise real (nunca modo demo, nunca erro).
    await salvarCache(jogo, mercado, result);

    return NextResponse.json(result);

  } catch (e) {
    logErro('analyze', { jogo, mercado }, e);
    const motivo = e?.name === 'TimeoutError' || /abort/i.test(e?.message || '')
      ? 'A análise demorou demais e foi interrompida (timeout). A IA pode estar sobrecarregada — tente novamente.'
      : 'Erro inesperado ao processar a análise. Tente novamente.';
    return NextResponse.json(demoResult(jogo || 'Jogo', mercado || 'Lay 2x2', motivo));
  }
}
