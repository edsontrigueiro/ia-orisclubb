import { fetchComRetry } from './fetchUtil';

// Log estruturado: facilita achar no Vercel exatamente em qual etapa e
// confronto algo falhou, em vez de só um texto solto sem contexto.
export function logErro(etapa, contexto, erro) {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    etapa,
    ...contexto,
    erro: erro?.message || String(erro),
  }));
}

function parseTimes(jogo) {
  // Defesa extra: mesmo que o handler já valide tipo antes de chamar aqui,
  // não custa blindar a função em si contra input não-string.
  if (typeof jogo !== 'string') return { timeA: null, timeB: null, paisA: null, paisB: null };
  // Aceita "vs", "vs." (com ponto) e "x" como separador — "vs." sem o ponto
  // opcional no regex fazia o split falhar silenciosamente, tratando o jogo
  // inteiro como um único nome de time e o segundo como ausente.
  const partes = jogo.split(/\s+vs\.?\s+|\s+x\s+/i);

  // Times com o mesmo nome existem em países diferentes (River Plate, Nacional,
  // Independiente, Always Ready, etc. se repetem na América do Sul). Se o
  // usuário escrever "River Plate (Uruguai) vs Nacional", extrai o país entre
  // parênteses pra desambiguar a busca, em vez de confiar só no nome.
  function extrair(parte) {
    if (!parte) return { nome: null, pais: null };
    const m = parte.trim().replace(/[.,]+$/, '').match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (m) return { nome: m[1].trim(), pais: m[2].trim() };
    return { nome: parte.trim().replace(/[.,]+$/, ''), pais: null };
  }

  const a = extrair(partes[0]);
  const b = extrair(partes[1]);
  return { timeA: a.nome || null, timeB: b.nome || null, paisA: a.pais, paisB: b.pais };
}

// A API devolve o país em inglês ("Uruguay"), mas o usuário escreve em
// português ("Uruguai") — sem isso, a dica de país nunca bateria com nada.
const PAISES_PT_EN = {
  uruguai: 'uruguay', paraguai: 'paraguay', brasil: 'brazil', equador: 'ecuador',
  mexico: 'mexico', espanha: 'spain', inglaterra: 'england', italia: 'italy',
  alemanha: 'germany', franca: 'france', holanda: 'netherlands', belgica: 'belgium',
  suica: 'switzerland', russia: 'russia', turquia: 'turkey', grecia: 'greece',
  japao: 'japan', coreia: 'south korea', marrocos: 'morocco', egito: 'egypt',
};

function normalizarPais(p) {
  if (!p) return null;
  const limpo = p.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return PAISES_PT_EN[limpo] || limpo;
}

// Retorna { id, exato } em vez de só o id. "exato" indica se achamos um nome
// IGUAL (ou igual + país confirmado) ao texto que o usuário digitou. Quando
// "exato" é false, o código caiu pro primeiro resultado de busca por
// relevância da API — pode ser o time certo, mas pode ser um homônimo de
// outro país/divisão. Isso importa porque, se o time for o errado, TODOS os
// dados da análise (forma, H2H, odds) ficam errados de forma silenciosa e
// confiante — sem esse flag, nada no sistema detecta isso.
async function buscarIdTime(nome, headers, paisHint = null) {
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
    const exatos = candidatos.filter(c => c.team?.name?.trim().toLowerCase() === alvo);

    // Nomes de clube se repetem entre países (River Plate, Nacional,
    // Independiente...). Se o usuário deu uma dica de país explícita e ela
    // bate com um dos candidatos de nome exato, usa esse — não o primeiro
    // que a API achar.
    if (paisHint && exatos.length > 1) {
      const paisNorm = normalizarPais(paisHint);
      const comPais = exatos.find(c => normalizarPais(c.team?.country) === paisNorm);
      if (comPais) return { id: comPais.team.id, exato: true };
    }

    if (exatos.length > 0) return { id: exatos[0].team.id, exato: true };
    return candidatos[0]?.team?.id ? { id: candidatos[0].team.id, exato: false } : null;
  } catch (e) {
    logErro('buscarIdTime', { nome, paisHint }, e);
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

// Escanteios vivem num endpoint SEPARADO do de gols (/fixtures/statistics,
// por partida individual) — não tem como pegar "forma recente de escanteios"
// sem buscar jogo a jogo. Mais caro (1 chamada extra por partida), mas é o
// único jeito de ter dado real em vez de estimativa — usado só quando
// explicitamente pedido (mercado de escanteios, ou o preview de estatísticas).
export async function buscarEscanteiosJogo(fixtureId, headers) {
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/fixtures/statistics?fixture=${fixtureId}`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const blocos = data?.response || [];
    let total = 0, achou = false;
    for (const b of blocos) {
      const stat = (b.statistics || []).find(s => s.type === 'Corner Kicks');
      if (stat && stat.value != null) { total += Number(stat.value) || 0; achou = true; }
    }
    return achou ? total : null;
  } catch (e) {
    logErro('buscarEscanteiosJogo', { fixtureId }, e);
    return null;
  }
}

// Busca escanteios de uma lista de partidas (cada uma com .fixture.id) em
// paralelo e devolve a média de escanteios TOTAIS (dos dois lados somados)
// por jogo, ignorando partidas sem esse dado disponível.
async function mediaEscanteios(fixtures, headers) {
  const ids = fixtures.map(f => f.fixture?.id).filter(Boolean);
  if (ids.length === 0) return null;
  const valores = await Promise.all(ids.map(id => buscarEscanteiosJogo(id, headers)));
  const validos = valores.filter(v => v != null);
  if (validos.length === 0) return null;
  return {
    jogos_considerados: validos.length,
    media_escanteios: +(validos.reduce((a, b) => a + b, 0) / validos.length).toFixed(2),
  };
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
      data: f.fixture?.date || null,
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
export function ehCompeticaoDeCopa(round, ligaNome) {
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
// "complemento" = o valor que fecha o par de duas pontas dentro do MESMO
// tipo de aposta (ex: "Over 1.5" x "Under 1.5") — usado pra de-vigar a odd
// (remover a margem da casa) sem nenhuma chamada extra de API, já que os
// dois valores vêm na mesma resposta de /odds. Só existe pra mercados de
// duas saídas puras; Double Chance (Dupla Chance/Lay Empate) tem 3 saídas
// sobrepostas e não entra nesse cálculo — ver Gate 7 no route.js.
const ODDS_MAPA = {
  '+1.5 Gols':      { bet: 'Goals Over/Under', value: 'Over 1.5', complemento: 'Under 1.5' },
  '+0.5 Gols':      { bet: 'Goals Over/Under', value: 'Over 0.5', complemento: 'Under 0.5' },
  'Under 3.5 Gols': { bet: 'Goals Over/Under', value: 'Under 3.5', complemento: 'Over 3.5' },
  'Dupla Chance':   { bet: 'Double Chance', value: null }, // valor varia conforme quem é o favorito, tratado abaixo
  // Lay Empate = apostar CONTRA o empate = exatamente o valor "Home/Away"
  // do mercado Double Chance (casas de apostas já vendem isso pronto).
  'Lay Empate':      { bet: 'Double Chance', value: 'Home/Away' },
  'BTTS Não':        { bet: 'Both Teams Score', value: 'No', complemento: 'Yes' },
  '+0.5 Gols 1T':    { bet: 'Goals Over/Under First Half', value: 'Over 0.5', complemento: 'Under 0.5' },
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

    // Double Chance SEM valor fixo = Dupla Chance: devolve as duas opções
    // relevantes (Home/Draw e Draw/Away) e deixa a IA decidir qual bate com
    // o favorito que ELA identificou — o código não sabe ainda quem é
    // favorito nesse ponto. Mercados como Lay Empate JÁ sabem o valor exato
    // que querem ("Home/Away") e caem no branch genérico abaixo, não aqui.
    if (mapa.bet === 'Double Chance' && mapa.value === null) {
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

    // Genérico: pega a média da odd pro valor específico do mercado (ex:
    // "Over 1.5" em Goals Over/Under, "No" em Both Teams Score, "Home/Away"
    // em Double Chance pra Lay Empate) entre todas as casas que oferecem.
    // Também coleta o valor COMPLEMENTAR (mesma resposta, sem custo extra)
    // quando o mapa define um — é o que permite de-vigar a odd abaixo.
    const valores = [];
    const valoresComplemento = [];
    for (const bm of bookmakers) {
      const aposta = bm.bets?.find(b => b.name === mapa.bet);
      const v = aposta?.values?.find(v => v.value === mapa.value);
      if (v) valores.push(parseFloat(v.odd));
      if (mapa.complemento) {
        const vc = aposta?.values?.find(v => v.value === mapa.complemento);
        if (vc) valoresComplemento.push(parseFloat(vc.odd));
      }
    }
    if (valores.length === 0) return null;
    const oddMedia = +(valores.reduce((a, b) => a + b, 0) / valores.length).toFixed(2);

    // De-vig: soma das probabilidades implícitas das duas pontas (1/odd)
    // é sempre > 1 numa casa de apostas real — o excesso é a margem da
    // casa (overround). Dividir a probabilidade bruta do lado que nos
    // interessa por essa soma remove a margem e dá a probabilidade "justa"
    // que o mercado está de fato precificando. Só calculável quando há
    // odd do complemento também cotada (nem toda casa lista os dois lados
    // do mesmo tipo de aposta) — se não houver, fica null e o Gate 7 no
    // route.js simplesmente não se aplica pra essa análise.
    let probabilidadeDevigada = null;
    if (mapa.complemento && valoresComplemento.length > 0) {
      const oddComplementoMedia = valoresComplemento.reduce((a, b) => a + b, 0) / valoresComplemento.length;
      const probBruta = 1 / oddMedia;
      const probComplementoBruta = 1 / oddComplementoMedia;
      const overround = probBruta + probComplementoBruta;
      probabilidadeDevigada = +((probBruta / overround) * 100).toFixed(1);
    }

    return {
      mercado,
      valor: mapa.value,
      odd_media: oddMedia,
      casas_consultadas: valores.length,
      probabilidade_devigada: probabilidadeDevigada,
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
  let golsMarcados1T = 0, golsSofridos1T = 0, validos1T = 0, jogos1TBaixo = 0, jogos1TSemGols = 0;

  for (const f of jogos) {
    const homeId = f.teams?.home?.id, awayId = f.teams?.away?.id;
    // Se nenhum dos dois lados bate com o time que estamos agregando, o
    // registro está malformado/incompleto — pular em vez de assumir "fora"
    // por padrão e atribuir um placar que pode nem ser desse time.
    if (homeId !== teamId && awayId !== teamId) continue;
    const ehCasa = homeId === teamId;
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
      if (golsPro1T + golsContra1T === 0) jogos1TSemGols++;
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
      // % dos jogos em que o 1T terminou 0x0 — o inverso é exatamente a
      // pergunta do mercado "+0.5 Gols 1T" (pelo menos 1 gol no intervalo).
      pct_jogos_1t_sem_gols: +((jogos1TSemGols / validos1T) * 100).toFixed(0),
    },
  };
}

// Estatísticas via /teams/statistics ficam PRESAS à liga+temporada do
// próximo jogo. Em torneios recém-iniciados (ex: fase de grupos de Copa do
// Mundo), isso reduz a amostra a 1-2 jogos mesmo que o time tenha dezenas de
// partidas recentes em eliminatórias/amistosos. Esta função busca os últimos
// jogos do time SEM esse travamento de competição, pra servir de base mais
// robusta quando a amostra "presa" à competição atual for pequena.
async function buscarFormaRecente(teamId, headers, qtd = 10, incluirEscanteios = false) {
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
      // Escanteio só é buscado (1 chamada extra por partida) quando
      // explicitamente pedido — caro pra valer a pena quando ninguém vai usar.
      escanteios: incluirEscanteios ? await mediaEscanteios(jogos, headers) : null,
      // Lista crua dos últimos jogos (placar, data, mando) — fica disponível
      // pra quem quiser (preview de estatísticas), mas o analyze/route.js
      // remove esse campo antes de montar o prompt da IA, pra não inflar o
      // tamanho da chamada em toda análise só por causa de um recurso que
      // só a grade do dia usa.
      _jogos_recentes_brutos: jogos.slice(0, 10).map(f => ({
        data: f.fixture?.date,
        casa: f.teams?.home?.name,
        fora: f.teams?.away?.name,
        placar: `${f.goals?.home ?? '?'}-${f.goals?.away ?? '?'}`,
        eh_casa: f.teams?.home?.id === teamId,
      })),
    };
  } catch (e) {
    logErro('buscarFormaRecente', { teamId }, e);
    return null;
  }
}

// /teams/statistics também devolve gols agrupados por faixa de minuto
// ("0-15", "16-30", "31-45", etc.) — uma visão de TEMPORADA INTEIRA de quando
// os gols desse time costumam sair, com amostra bem maior que os ~10 jogos
// usados pra calcular "primeiro_tempo" em forma_recente (que é derivado
// jogo a jogo do placar do intervalo). Usa os totais (não o "percentage" que
// a API já manda como string formatada) pra não depender de parsing de texto.
function pctGolsAteOIntervalo(porMinuto) {
  if (!porMinuto) return null;
  const faixas1T = ['0-15', '16-30', '31-45'];
  let total1T = 0, totalGeral = 0;
  for (const faixa of Object.keys(porMinuto)) {
    const t = porMinuto[faixa]?.total;
    if (t == null) continue;
    totalGeral += t;
    if (faixas1T.includes(faixa)) total1T += t;
  }
  if (totalGeral === 0) return null;
  return +((total1T / totalGeral) * 100).toFixed(0);
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
      // % dos gols da TEMPORADA (marcados/sofridos) que saíram até os 45min
      // — sinal de "começa rápido"/"começa devagar" com amostra de temporada
      // inteira, não só os últimos 10 jogos. Null se a API não trouxer esse
      // detalhamento pra essa liga/temporada (cobertura varia por competição).
      pct_gols_marcados_1t_temporada: pctGolsAteOIntervalo(s.goals?.for?.minute),
      pct_gols_sofridos_1t_temporada: pctGolsAteOIntervalo(s.goals?.against?.minute),
      // A própria resposta de /teams/statistics já vem com o recorte casa/fora
      // pra esses campos — não custa nenhuma chamada extra, só não estávamos
      // lendo. É uma segunda fonte de mando de campo (presa à temporada
      // atual), complementar ao "como_mandante/como_visitante" calculado a
      // partir dos jogos individuais em "forma_recente_time_a/b".
      como_mandante: s.fixtures?.played?.home != null ? {
        jogos_disputados: s.fixtures?.played?.home ?? null,
        vitorias: s.fixtures?.wins?.home ?? null,
        empates: s.fixtures?.draws?.home ?? null,
        derrotas: s.fixtures?.loses?.home ?? null,
        media_gols_marcados: s.goals?.for?.average?.home ?? null,
        media_gols_sofridos: s.goals?.against?.average?.home ?? null,
        jogos_sem_sofrer_gol: s.clean_sheet?.home ?? null,
        jogos_sem_marcar_gol: s.failed_to_score?.home ?? null,
      } : null,
      como_visitante: s.fixtures?.played?.away != null ? {
        jogos_disputados: s.fixtures?.played?.away ?? null,
        vitorias: s.fixtures?.wins?.away ?? null,
        empates: s.fixtures?.draws?.away ?? null,
        derrotas: s.fixtures?.loses?.away ?? null,
        media_gols_marcados: s.goals?.for?.average?.away ?? null,
        media_gols_sofridos: s.goals?.against?.average?.away ?? null,
        jogos_sem_sofrer_gol: s.clean_sheet?.away ?? null,
        jogos_sem_marcar_gol: s.failed_to_score?.away ?? null,
      } : null,
    };
  } catch (e) {
    logErro('buscarEstatisticasTime', { teamId, leagueId, season }, e);
    return null;
  }
}
// Monta um pacote de dados reais sobre o confronto. Retorna sempre um objeto
// explícito indicando o que foi possível obter, para o prompt nunca tratar
// dado ausente como dado real.
//
// opts.mercado: usado pela análise da IA (define critério de odds e, se
//   igual a "+8.5 Escanteios", ativa busca de escanteio automaticamente).
// opts.incluirEscanteios: força a busca de escanteio independente do
//   mercado — usado pelo preview de estatísticas na grade do dia, que quer
//   mostrar escanteio sempre, sem precisar fingir um mercado específico.
export async function getFootballData(jogo, opts = {}) {
  const { mercado = null, incluirEscanteios = null } = opts;
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) {
    return { disponivel: false, motivo: 'FOOTBALL_API_KEY não configurada.' };
  }
  const headers = { 'x-apisports-key': key };

  const { timeA, timeB, paisA, paisB } = parseTimes(jogo);
  if (!timeA || !timeB) {
    return { disponivel: false, motivo: 'Não foi possível identificar os dois times no texto informado (use "Time A vs Time B").' };
  }

  const [matchA, matchB] = await Promise.all([
    buscarIdTime(timeA, headers, paisA),
    buscarIdTime(timeB, headers, paisB),
  ]);

  if (!matchA || !matchB) {
    const faltando = !matchA ? timeA : timeB;
    return { disponivel: false, motivo: `Time "${faltando}" não encontrado na base da API-Football.` };
  }
  const idA = matchA.id, idB = matchB.id;

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

  // Escanteio é caro (1 chamada extra por partida) — só busca quando o
  // mercado selecionado de fato precisa desse dado, OU quando explicitamente
  // pedido via incluirEscanteios (preview de estatísticas).
  const precisaEscanteios = incluirEscanteios ?? (mercado === '+8.5 Escanteios');

  const [h2h, statsA, statsB, formaA, formaB, fixtureFuturo] = await Promise.all([
    buscarHeadToHead(idA, idB, headers),
    buscarEstatisticasTime(idA, leagueIdA, seasonA, headers),
    buscarEstatisticasTime(idB, leagueIdB, seasonB, headers),
    buscarFormaRecente(idA, headers, 10, precisaEscanteios),
    buscarFormaRecente(idB, headers, 10, precisaEscanteios),
    buscarFixtureFuturo(idA, idB, headers),
  ]);

  // Escanteios do H2H — média dos confrontos diretos específicos entre
  // esses dois times, separada da forma recente geral de cada um.
  const escanteiosH2H = precisaEscanteios && h2h?.length
    ? await mediaEscanteios(h2h, headers)
    : null;

  const oddsReais = mercado && ODDS_MAPA[mercado]
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

  // A lista crua de jogos recentes é útil pro preview de estatísticas, mas
  // não precisa ir pro prompt da IA (ela já recebe os números agregados em
  // "forma_recente_time_a/b") — extrai pro nível superior e tira do objeto
  // que vira "DADOS" no prompt.
  const jogosRecentesA = formaA?._jogos_recentes_brutos || null;
  const jogosRecentesB = formaB?._jogos_recentes_brutos || null;
  if (formaA) delete formaA._jogos_recentes_brutos;
  if (formaB) delete formaB._jogos_recentes_brutos;

  return {
    disponivel: true,
    time_a: timeA,
    time_b: timeB,
    // Confiança da identificação dos times: false quando o nome digitado
    // não bateu exatamente com nenhum time da base e o código caiu pro
    // primeiro resultado de busca por relevância — risco real de estar
    // analisando o time errado (homônimo de outro país/divisão), com toda
    // a análise saindo "confiante" em cima de dado da entidade errada.
    match_exato_a: matchA.exato,
    match_exato_b: matchB.exato,
    // IDs resolvidos dos dois times na base da API-Football — usado pelo
    // Gate 6 (correlação de exposição, em analyze/route.js) pra comparar
    // se dois sinais aprovados no mesmo dia são do MESMO confronto por ID,
    // não por texto (nome digitado pode variar: "Flamengo" vs "Flamengo RJ"
    // apontam pro mesmo id_time_a e não podem escapar da checagem por
    // divergência de grafia).
    id_time_a: idA,
    id_time_b: idB,
    // Id e data do confronto exato (Time A x Time B) — usado pro cron de
    // resolução automática de resultado conseguir, dias depois, buscar o
    // placar final desse jogo específico e fechar o loop de calibração sem
    // depender de alguém marcar manualmente.
    fixture_id: fixtureFuturo?.id || null,
    data_jogo: fixtureFuturo?.data || null,
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
    // Média de escanteios nos confrontos diretos específicos (só calculado
    // quando incluirEscanteios/mercado de escanteios — null nos demais casos).
    escanteios_h2h: escanteiosH2H,
    // Lista crua de jogos recentes — só pro preview de estatísticas, fora do
    // que normalmente vira prompt (analyze/route.js ignora esses 2 campos).
    jogos_recentes_time_a: jogosRecentesA,
    jogos_recentes_time_b: jogosRecentesB,
  };
}
