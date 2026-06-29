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
const ODDS_MAPA = {
  '+1.5 Gols':      { bet: 'Goals Over/Under', value: 'Over 1.5' },
  '+0.5 Gols':      { bet: 'Goals Over/Under', value: 'Over 0.5' },
  'Under 3.5 Gols': { bet: 'Goals Over/Under', value: 'Under 3.5' },
  'Dupla Chance':   { bet: 'Double Chance', value: null }, // valor varia conforme quem é o favorito, tratado abaixo
  // Lay Empate = apostar CONTRA o empate = exatamente o valor "Home/Away"
  // do mercado Double Chance (casas de apostas já vendem isso pronto).
  'Lay Empate':      { bet: 'Double Chance', value: 'Home/Away' },
  'BTTS Não':        { bet: 'Both Teams Score', value: 'No' },
  '+0.5 Gols 1T':    { bet: 'Goals Over/Under First Half', value: 'Over 0.5' },
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
