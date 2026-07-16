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
  // Só jogos encerrados nos 90 minutos: em jogos com prorrogação (AET/PEN),
  // o endpoint de estatísticas soma os escanteios dos 120 minutos sem como
  // separar o tempo regulamentar — incluir esses jogos inflaria a média de
  // um dado que existe pra prever um mercado que liquida nos 90.
  const ids = fixtures
    .filter(f => f.fixture?.status?.short === 'FT' || f.fixture?.status?.short == null)
    .map(f => f.fixture?.id)
    .filter(Boolean);
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
// Busca a posição na tabela de cada time — só usado no mercado "Dupla
// Chance", e só quando os dois times estão na MESMA liga+temporada (é o
// caso comum de liga doméstica; se divergem — ex: times de confederações
// diferentes — comparar posição em tabelas diferentes não diz nada útil,
// então nem tenta). Reforça (ou contradiz) o critério de "favorito claro"
// que hoje só olha média de gols — um time pode ter médias parecidas com
// o adversário mas estar 10 posições acima na tabela por eficiência
// (menos gols sofridos em jogos decisivos, não só volume). Retorna null
// em qualquer cenário sem tabela tradicional disponível (grupo de copa
// recém-começado, liga sem esse endpoint no plano da API) — nunca inventa
// posição a partir de outro dado.
async function buscarClassificacao(leagueId, season, idA, idB, headers) {
  if (!leagueId || !season) return null;
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/standings?league=${leagueId}&season=${season}`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // A API aninha em league.standings[0] pro caso comum (liga com tabela
    // única); ligas com grupos (ex: fase de grupos) trazem standings[1..N],
    // uma por grupo — não tenta adivinhar qual grupo é o certo nesse caso,
    // simplesmente não acha o time em standings[0] e retorna null.
    const tabela = data?.response?.[0]?.league?.standings?.[0] || [];
    if (tabela.length === 0) return null;
    const entradaA = tabela.find(t => t.team?.id === idA);
    const entradaB = tabela.find(t => t.team?.id === idB);
    if (!entradaA || !entradaB) return null;
    return {
      total_times_liga: tabela.length,
      time_a: { posicao: entradaA.rank, pontos: entradaA.points, saldo_gols: entradaA.goalsDiff },
      time_b: { posicao: entradaB.rank, pontos: entradaB.points, saldo_gols: entradaB.goalsDiff },
    };
  } catch (e) {
    logErro('buscarClassificacao', { leagueId, season }, e);
    return null;
  }
}

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

// De-vig de verdade pra Dupla Chance/Lay Empate — o Gate 7 (baseado em
// buscarOddsReais acima) deixa esses dois de fora porque Double Chance é
// mercado de 3 saídas SOBREPOSTAS (Home/Draw, Draw/Away, Home/Away cada
// um cobre 2 dos 3 resultados possíveis) — a soma das probabilidades
// implícitas dos 3 dá 2 + overround, não 1 + overround como nos mercados
// de duas pontas puras, então o mesmo cálculo simples do Gate 7 dá
// resultado errado se aplicado aqui.
// A solução correta é usar o mercado "Match Winner" (1X2 clássico: Home,
// Draw, Away, mutuamente exclusivos) da MESMA resposta de /odds que já é
// buscada — sem chamada de API extra, só um bet type diferente dentro do
// mesmo payload. Com os 3 valores mutuamente exclusivos, o de-vig padrão
// (dividir cada probabilidade bruta pela soma das três) é matematicamente
// correto.
async function buscarOddsMatchWinner(fixtureId, headers) {
  if (!fixtureId) return null;
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/odds?fixture=${fixtureId}`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const bookmakers = data?.response?.[0]?.bookmakers || [];
    if (bookmakers.length === 0) return null;

    const valores = { Home: [], Draw: [], Away: [] };
    for (const bm of bookmakers) {
      const aposta = bm.bets?.find(b => b.name === 'Match Winner');
      for (const v of (aposta?.values || [])) {
        if (valores[v.value]) valores[v.value].push(parseFloat(v.odd));
      }
    }
    const media = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const oddHome = media(valores.Home), oddDraw = media(valores.Draw), oddAway = media(valores.Away);
    if (oddHome == null || oddDraw == null || oddAway == null) return null;

    const pHome = 1 / oddHome, pDraw = 1 / oddDraw, pAway = 1 / oddAway;
    const overround = pHome + pDraw + pAway;

    return {
      casas_consultadas: bookmakers.length,
      prob_devigada_home: +((pHome / overround) * 100).toFixed(1),
      prob_devigada_draw: +((pDraw / overround) * 100).toFixed(1),
      prob_devigada_away: +((pAway / overround) * 100).toFixed(1),
    };
  } catch (e) {
    logErro('buscarOddsMatchWinner', { fixtureId }, e);
    return null;
  }
}
// Placar dos 90 MINUTOS de um fixture, independente de prorrogação.
// Em jogos decididos na prorrogação/pênaltis (status AET/PEN), o campo
// "goals" da API-Football inclui os gols do tempo extra — mas toda a
// estatística deste sistema existe pra prever mercados que liquidam nos 90
// minutos, então médias, H2H e forma precisam ser calculados sobre
// "score.fulltime" (placar ao fim do tempo normal) nesses jogos. Pra FT
// comum, goals e score.fulltime são idênticos e goals é mais confiável
// (sempre presente), então segue sendo a fonte padrão.
function golsRegulamentares(f) {
  const status = f?.fixture?.status?.short;
  if (status === 'AET' || status === 'PEN') {
    return { home: f?.score?.fulltime?.home ?? null, away: f?.score?.fulltime?.away ?? null };
  }
  return { home: f?.goals?.home ?? null, away: f?.goals?.away ?? null };
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
    const placar90 = golsRegulamentares(f);
    const golsPro = ehCasa ? placar90.home : placar90.away;
    const golsContra = ehCasa ? placar90.away : placar90.home;
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
    // DIAGNÓSTICO TEMPORÁRIO (remover depois de identificar a causa raiz):
    // loga incondicionalmente pra ver o formato real da resposta quando nem
    // "!res.ok" nem "errors no corpo" capturam o caso — precisa ver o corpo
    // cru de verdade em vez de continuar hipotetizando o formato da falha.
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      etapa: 'DEBUG_buscarFormaRecente',
      teamId,
      status: res.status,
      temErrors: !!(data?.errors && Object.keys(data.errors).length > 0),
      qtdResultados: Array.isArray(data?.response) ? data.response.length : `nao-array:${typeof data?.response}`,
      results: data?.results,
      paging: data?.paging,
      amostraCrua: JSON.stringify(data).slice(0, 500),
    }));
    if (data?.errors && Object.keys(data.errors).length > 0) {
      logErro('buscarFormaRecente_erro_no_corpo', { teamId, errors: data.errors }, new Error('API devolveu 200 com erro no corpo'));
      return null;
    }
    const jogos = (data?.response || [])
      // CORREÇÃO (auditoria jul/2026): o filtro anterior só aceitava 'FT' —
      // jogos de copa decididos na prorrogação/pênaltis (AET/PEN) sumiam
      // COMPLETAMENTE da forma recente, encolhendo a amostra de times em
      // mata-mata e enviesando a forma pra só jogos de liga. Agora entram,
      // e agregarJogos usa o placar dos 90 minutos (golsRegulamentares)
      // pra não inflar médias com gols de prorrogação.
      .filter(f => ['FT', 'AET', 'PEN'].includes(f.fixture?.status?.short))
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
      _jogos_recentes_brutos: jogos.slice(0, 10).map(f => {
        const placar90 = golsRegulamentares(f);
        return {
          data: f.fixture?.date,
          casa: f.teams?.home?.name,
          fora: f.teams?.away?.name,
          placar: `${placar90.home ?? '?'}-${placar90.away ?? '?'}`,
          eh_casa: f.teams?.home?.id === teamId,
        };
      }),
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
  // Faixas de prorrogação ("91-105", "106-120") ficam FORA do total: o
  // denominador deve ser só os gols do tempo regulamentar, senão times com
  // jogos de mata-mata têm o pct de 1T deflacionado por gols que não
  // existem no universo dos mercados (que liquidam nos 90 minutos).
  const faixasProrrogacao = ['91-105', '106-120'];
  let total1T = 0, totalGeral = 0;
  for (const faixa of Object.keys(porMinuto)) {
    if (faixasProrrogacao.includes(faixa)) continue;
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
    // DIAGNÓSTICO TEMPORÁRIO (remover depois de identificar a causa raiz).
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      etapa: 'DEBUG_buscarEstatisticasTime',
      teamId,
      leagueId,
      season,
      status: res.status,
      temErrors: !!(data?.errors && Object.keys(data.errors).length > 0),
      temResponse: data?.response != null,
      results: data?.results,
      amostraCrua: JSON.stringify(data).slice(0, 500),
    }));
    if (data?.errors && Object.keys(data.errors).length > 0) {
      logErro('buscarEstatisticasTime_erro_no_corpo', { teamId, leagueId, season, errors: data.errors }, new Error('API devolveu 200 com erro no corpo'));
      return null;
    }
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

// Amostra mínima pra considerar a estatística de temporada utilizável.
// Abaixo disso, um "total_de_jogos: 1" técnico é estatisticamente igual a
// não ter dado nenhum — não dá pra tirar média confiável de 1-2 jogos.
const AMOSTRA_MINIMA_ESTATISTICA_TEMPORADA = 3;

// BUG (auditoria jul/2026): leagueId/season pra estatística de temporada
// vêm do "próximo jogo" do time (buscarProximoJogo). Isso quebra sempre que
// o próprio próximo jogo É a estreia do time numa competição nova — copa
// continental (Champions/Europa/Conference League, fases preliminares) ou
// qualquer torneio recém-começado pro time. Nesses casos leagueIdA/B aponta
// pra uma competição em que o time jogou 0-1 partida na temporada, e
// /teams/statistics não tem amostra nenhuma pra devolver — retorna null (ou
// um objeto tecnicamente não-nulo mas com jogos_disputados baixíssimo),
// mesmo o time tendo uma temporada inteira de jogos reais na liga doméstica.
// Descobre a liga doméstica de pontos corridos do time (type "League", não
// "Cup" nem confederação) via /leagues?team=X&current=true. Times normalmente
// têm só uma liga doméstica ativa — pega a primeira do tipo "League" que a
// API retornar. Se não achar nenhuma (raro — seleção nacional, time sem liga
// doméstica ativa no momento), retorna null e o chamador mantém o que já tinha.
async function buscarLigaDomestica(teamId, headers) {
  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/leagues?team=${teamId}&current=true`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const ligas = data?.response || [];
    const domestica = ligas.find(l => l.league?.type === 'League');
    if (!domestica) return null;
    const seasonAtual = domestica.seasons?.find(s => s.current) || domestica.seasons?.[domestica.seasons.length - 1];
    if (!seasonAtual) return null;
    return { leagueId: domestica.league.id, season: seasonAtual.year };
  } catch (e) {
    logErro('buscarLigaDomestica', { teamId }, e);
    return null;
  }
}

// Wrapper: tenta a estatística na liga do próximo jogo primeiro (comportamento
// original, zero custo extra no caso comum). Só dispara a chamada extra de
// fallback quando a amostra vier nula ou pequena demais pra ser confiável —
// aí sim busca a liga doméstica e tenta de novo nela. Se a liga doméstica for
// a MESMA que já tentou (time cuja próxima partida é na própria liga
// doméstica — caso comum, sem custo extra de fato nenhuma vez que já falhou
// por outro motivo que não "liga errada"), não repete a chamada à toa.
async function buscarEstatisticasComFallback(teamId, leagueId, season, headers) {
  const stats = await buscarEstatisticasTime(teamId, leagueId, season, headers);
  if (stats && (stats.jogos_disputados ?? 0) >= AMOSTRA_MINIMA_ESTATISTICA_TEMPORADA) {
    return stats;
  }

  const ligaDomestica = await buscarLigaDomestica(teamId, headers);
  if (!ligaDomestica) return stats;
  if (ligaDomestica.leagueId === leagueId && ligaDomestica.season === season) return stats;

  const statsDomestica = await buscarEstatisticasTime(
    teamId, ligaDomestica.leagueId, ligaDomestica.season, headers
  );
  // Só substitui se o fallback realmente trouxe amostra melhor — nunca troca
  // um dado (mesmo pequeno) por um null do fallback.
  if (statsDomestica && (statsDomestica.jogos_disputados ?? 0) >= (stats?.jogos_disputados ?? 0)) {
    return statsDomestica;
  }
  return stats;
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
// Fixture congestion: dias desde o último jogo e quantos jogos o time
// disputou nos últimos 7/14 dias, contados a partir da data do PRÓXIMO
// jogo (não de "agora") — pra medir o desgaste real que o time vai levar
// pra entrada em campo, não desgaste até o momento em que a análise foi
// rodada. Se a data do próximo jogo ainda não foi resolvida (raro — H2H
// futuro não encontrado), cai pra "agora" como aproximação, com a mesma
// lista de jogos recentes já buscada (zero custo de API extra).
// Deliberadamente NÃO é um gate — calendário apertado nem sempre piora o
// desempenho (times grandes rotacionam elenco pra preservar titulares;
// times pequenos às vezes não têm profundidade de elenco pra rotacionar e
// SENTEM mais o desgaste). Direção do efeito depende de contexto que só a
// IA consegue julgar — por isso vira dado informativo + instrução no
// prompt (Regra 15), não reprovação automática.
function calcularDescanso(jogosRecentesBrutos, dataProximoJogo) {
  if (!jogosRecentesBrutos?.length) return null;
  const dataRef = dataProximoJogo ? new Date(dataProximoJogo) : new Date();
  const ordenados = [...jogosRecentesBrutos]
    .filter(j => j.data)
    .sort((a, b) => new Date(b.data) - new Date(a.data));
  if (ordenados.length === 0) return null;

  const diasDesde = j => (dataRef - new Date(j.data)) / 86400000;
  const diasDesdeUltimoJogo = Math.round(diasDesde(ordenados[0]));
  // Só conta jogos ANTES da data de referência (dias >= 0) — evita contar
  // o próprio jogo futuro caso ele já apareça na lista por algum motivo.
  const jogosUltimos7Dias = ordenados.filter(j => diasDesde(j) >= 0 && diasDesde(j) <= 7).length;
  const jogosUltimos14Dias = ordenados.filter(j => diasDesde(j) >= 0 && diasDesde(j) <= 14).length;

  return {
    dias_desde_ultimo_jogo: diasDesdeUltimoJogo,
    jogos_ultimos_7_dias: jogosUltimos7Dias,
    jogos_ultimos_14_dias: jogosUltimos14Dias,
  };
}

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

  // Classificação faz sentido pros mercados que usam "favorito claro"/
  // "diferença de qualidade" como critério (Dupla Chance e, desde a adição
  // do Gate 15/16, também Lay Empate), e só quando os dois times estão
  // comprovadamente na mesma liga+temporada (senão a comparação de posição
  // não significa nada).
  const precisaClassificacao = (mercado === 'Dupla Chance' || mercado === 'Lay Empate') &&
    leagueIdA && leagueIdA === leagueIdB && seasonA === seasonB;

  const [h2h, statsA, statsB, formaA, formaB, fixtureFuturo, classificacao] = await Promise.all([
    buscarHeadToHead(idA, idB, headers),
    buscarEstatisticasComFallback(idA, leagueIdA, seasonA, headers),
    buscarEstatisticasComFallback(idB, leagueIdB, seasonB, headers),
    buscarFormaRecente(idA, headers, 10, precisaEscanteios),
    buscarFormaRecente(idB, headers, 10, precisaEscanteios),
    buscarFixtureFuturo(idA, idB, headers),
    precisaClassificacao ? buscarClassificacao(leagueIdA, seasonA, idA, idB, headers) : Promise.resolve(null),
  ]);

  // Escanteios do H2H — média dos confrontos diretos específicos entre
  // esses dois times, separada da forma recente geral de cada um.
  const escanteiosH2H = precisaEscanteios && h2h?.length
    ? await mediaEscanteios(h2h, headers)
    : null;

  const oddsReais = mercado && ODDS_MAPA[mercado]
    ? await buscarOddsReais(fixtureFuturo?.id, mercado, headers)
    : null;

  // De-vig correto (via Match Winner/1X2) só faz sentido pros dois
  // mercados que o Gate 7 deixa de fora — ver comentário em
  // buscarOddsMatchWinner. Não busca pros outros pra não gastar chamada
  // à toa numa análise que nunca vai usar esse dado.
  const oddsMatchWinner = (mercado === 'Dupla Chance' || mercado === 'Lay Empate')
    ? await buscarOddsMatchWinner(fixtureFuturo?.id, headers)
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
    .map(f => {
      // Placar dos 90 minutos — mesmo racional de golsRegulamentares: um
      // mata-mata que terminou 1-1 no tempo normal e 2-1 na prorrogação
      // precisa aparecer como "1-1" aqui, porque tanto a IA quanto os
      // Gates 13/18-22 leem esse placar pra prever mercados que liquidam
      // nos 90 minutos.
      const placar90 = golsRegulamentares(f);
      return {
        data: f.fixture?.date,
        // Calculado aqui no servidor, não deixado pra IA inferir da data —
        // tirar a IA de fazer aritmética de datas evita erro bobo e deixa a
        // instrução de "pesar o mais recente" objetiva e verificável.
        dias_atras: f.fixture?.date ? Math.round((Date.now() - new Date(f.fixture.date).getTime()) / 86400000) : null,
        casa: f.teams?.home?.name,
        fora: f.teams?.away?.name,
        placar: `${placar90.home ?? '?'}-${placar90.away ?? '?'}`,
        placar_1t: f.score?.halftime?.home != null
          ? `${f.score.halftime.home}-${f.score.halftime.away}`
          : null,
        // Indica se nesse confronto passado o mando de campo foi o mesmo do
        // jogo analisado agora (time A em casa) — confronto direto com o mesmo
        // mando vale mais como sinal do que um com os lados invertidos.
        mesmo_mando_atual: f.teams?.home?.id === idA,
      };
    });

  // A lista crua de jogos recentes é útil pro preview de estatísticas, mas
  // não precisa ir pro prompt da IA (ela já recebe os números agregados em
  // "forma_recente_time_a/b") — extrai pro nível superior e tira do objeto
  // que vira "DADOS" no prompt.
  const jogosRecentesA = formaA?._jogos_recentes_brutos || null;
  const jogosRecentesB = formaB?._jogos_recentes_brutos || null;
  if (formaA) delete formaA._jogos_recentes_brutos;
  if (formaB) delete formaB._jogos_recentes_brutos;

  // Anexado DEPOIS de tirar _jogos_recentes_brutos do que vai pro prompt,
  // mas calculado a partir da mesma lista (jogosRecentesA/B) — zero
  // chamada de API extra. Fica dentro de forma_recente_time_a/b (via
  // formaA.descanso) porque é semanticamente parte da forma recente do
  // time, não um bloco novo separado que a IA precisaria aprender a olhar.
  if (formaA) formaA.descanso = calcularDescanso(jogosRecentesA, fixtureFuturo?.data);
  if (formaB) formaB.descanso = calcularDescanso(jogosRecentesB, fixtureFuturo?.data);

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
    // Posição/pontos/saldo na tabela — null salvo quando mercado é "Dupla
    // Chance" ou "Lay Empate" E os dois times estão comprovadamente na
    // mesma liga+temporada (ver buscarClassificacao/precisaClassificacao).
    // Reforça o critério de "favorito claro"/"diferença de qualidade" com
    // um dado que médias de gols sozinhas não capturam: eficiência em jogos
    // decisivos, não só volume.
    classificacao,
    // De-vig via Match Winner — null salvo pra Dupla Chance/Lay Empate com
    // odds cotadas nos 3 resultados (ver Gate 8 em analyze/route.js).
    odds_1x2_devigada: oddsMatchWinner,
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
