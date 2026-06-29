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
