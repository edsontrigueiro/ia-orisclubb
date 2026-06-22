export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

const MERCADOS = {
  'Lay 2x2':      { min: 82 },
  'Lay Zebra':    { min: 85 },
  '+1.5 Gols':    { min: 83 },
  '+0.5 Gols':    { min: 88 },
  'Tênis':        { min: 84 },
  '-2.5 Gols 1T': { min: 86 },
};

function demoResult(jogo, mercado) {
  const min = MERCADOS[mercado]?.min || 82;
  const score = min + Math.floor(Math.random() * 15);
  return {
    evento: jogo,
    competicao: 'Modo Demo',
    score,
    aprovado: score >= min,
    odds_estimada: '1.20',
    probabilidade_real: 72 + Math.floor(Math.random() * 18),
    criterios_atendidos: ['H2H favorável', 'Forma recente positiva'],
    criterios_nao_atendidos: [],
    alertas: ['Configure ANTHROPIC_API_KEY para análise real'],
    insight: 'Análise em modo demonstração. Configure as variáveis de ambiente.',
    resumo: 'Configure ANTHROPIC_API_KEY e FOOTBALL_API_KEY para análise real com IA e dados ao vivo.',
    _minScore: min,
    _demo: true,
  };
}

function parseTimes(jogo) {
  const partes = jogo.split(/\s+vs\s+|\s+x\s+/i);
  return {
    timeA: partes[0]?.trim() || null,
    timeB: partes[1]?.trim() || null,
  };
}

async function buscarIdTime(nome, headers) {
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(nome)}`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.response?.[0]?.team?.id || null;
  } catch (e) {
    console.error('buscarIdTime exception:', e.message);
    return null;
  }
}

async function buscarProximoJogo(teamId, headers) {
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures?team=${teamId}&next=1`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.response?.[0] || null;
  } catch (e) {
    console.error('buscarProximoJogo exception:', e.message);
    return null;
  }
}

async function buscarHeadToHead(idA, idB, headers) {
  try {
    const res = await fetch(
      `https://v3.football.api-sports.io/fixtures/headtohead?h2h=${idA}-${idB}&last=10`,
      { headers }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.response || null;
  } catch (e) {
    console.error('buscarHeadToHead exception:', e.message);
    return null;
  }
}

async function buscarEstatisticasTime(teamId, leagueId, season, headers) {
  if (!leagueId || !season) return null;
  try {
    const res = await fetch(
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
    console.error('buscarEstatisticasTime exception:', e.message);
    return null;
  }
}

// Monta um pacote de dados reais sobre o confronto. Retorna sempre um objeto
// explícito indicando o que foi possível obter, para o prompt nunca tratar
// dado ausente como dado real.
async function getFootballData(jogo) {
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

  const [h2h, statsA, statsB] = await Promise.all([
    buscarHeadToHead(idA, idB, headers),
    buscarEstatisticasTime(idA, leagueIdA, seasonA, headers),
    buscarEstatisticasTime(idB, leagueIdB, seasonB, headers),
  ]);

  const h2hResumido = (h2h || []).slice(0, 10).map(f => ({
    data: f.fixture?.date,
    casa: f.teams?.home?.name,
    fora: f.teams?.away?.name,
    placar: `${f.goals?.home ?? '?'}-${f.goals?.away ?? '?'}`,
  }));

  return {
    disponivel: true,
    time_a: timeA,
    time_b: timeB,
    liga_time_a: proximoJogoA?.league?.name || null,
    liga_time_b: proximoJogoB?.league?.name || null,
    temporada_time_a: seasonA,
    temporada_time_b: seasonB,
    confrontos_diretos: h2hResumido.length ? h2hResumido : null,
    confrontos_diretos_indisponivel: h2hResumido.length === 0,
    estatisticas_time_a: statsA,
    estatisticas_time_b: statsB,
    estatisticas_indisponiveis: !statsA && !statsB,
  };
}

function montarSystemPrompt() {
  return `Você é um analista estatístico de apostas esportivas, rigoroso e conservador. Siga estas regras de forma inegociável:

1. Use SOMENTE os dados fornecidos no bloco "DADOS" abaixo. Nunca invente médias, placares de confrontos diretos, ou estatísticas que não estejam explicitamente presentes nos dados.
2. Se um campo de dados estiver nulo, ausente, ou marcado como indisponível, trate-o como informação que você NÃO TEM — não preencha com suposição genérica.
3. Quanto menos dados reais disponíveis, menor deve ser o "score" e o "probabilidade_real", e isso deve ser explicado em "alertas". Análise sem dados suficientes deve tender a "aprovado": false.
4. Os campos "criterios_atendidos" e "criterios_nao_atendidos" devem citar números concretos vindos dos dados (ex: "média de 1.8 gols marcados em 10 jogos"), nunca frases vagas como "boa forma" sem número de apoio.
5. Se os dados estiverem totalmente indisponíveis, diga isso claramente no "insight" e no "resumo", e ainda assim responda apenas com o JSON pedido.

Responda SOMENTE com JSON válido, sem markdown, sem texto fora do JSON.`;
}

export async function POST(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  try {
    const { jogo, mercado } = await request.json();
    if (!jogo || !mercado)
      return NextResponse.json({ error: 'Jogo e mercado obrigatórios.' }, { status: 400 });
    if (!MERCADOS[mercado])
      return NextResponse.json({ error: 'Mercado inválido.' }, { status: 400 });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json(demoResult(jogo, mercado));

    const min = MERCADOS[mercado].min;
    const dadosReais = await getFootballData(jogo);

    const blocoDados = dadosReais.disponivel
      ? `DADOS:\n${JSON.stringify(dadosReais)}`
      : `DADOS: indisponíveis. Motivo: ${dadosReais.motivo}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: montarSystemPrompt(),
        messages: [{
          role: 'user',
          content: `Analise "${jogo}" para o mercado "${mercado}". Score mínimo para aprovar: ${min}/100.

${blocoDados}

Responda SOMENTE JSON válido sem markdown, neste formato exato:
{"evento":"nome formatado","competicao":"liga ou null","score":0-100,"aprovado":bool,"odds_estimada":"1.XX","probabilidade_real":0-100,"criterios_atendidos":["..."],"criterios_nao_atendidos":["..."],"alertas":[],"insight":"frase curta explicando o score, citando dado real se houver","resumo":"2-3 frases operacionais para o trader"}`
        }]
      }),
    });

    if (!res.ok) {
      console.error('Anthropic error:', res.status, await res.text().catch(() => ''));
      return NextResponse.json(demoResult(jogo, mercado));
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.replace(/```json|```/g, '').trim();
    if (!text) return NextResponse.json(demoResult(jogo, mercado));

    const result = JSON.parse(text);
    result._minScore = min;
    result._dadosReaisUsados = dadosReais.disponivel;
    return NextResponse.json(result);

  } catch (e) {
    console.error('analyze error:', e.message);
    const body = await request.clone().json().catch(() => ({}));
    return NextResponse.json(demoResult(body.jogo || 'Jogo', body.mercado || 'Lay 2x2'));
  }
}
