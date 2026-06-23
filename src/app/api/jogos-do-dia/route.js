export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getCached, setCached } from '@/lib/cache';
import { fetchComRetry } from '@/lib/fetchUtil';

// 1h de cache: a grade de horários praticamente não muda durante o dia
// (só em casos raros de adiamento), então não vale gastar 1 chamada de
// API-Football por usuário a cada vez que a aba é aberta.
const CACHE_TTL_MS = 60 * 60 * 1000;

// Ligas mais relevantes aparecem primeiro na lista — isso é só ORDENAÇÃO,
// nenhum jogo é escondido. O resto aparece depois, agrupado por liga.
const LIGAS_PRIORIDADE = [
  2, 3,           // Champions League, Europa League
  1,              // Copa do Mundo
  39, 140, 135, 78, 61, // Premier League, La Liga, Serie A, Bundesliga, Ligue 1
  71, 73,         // Brasileirão Série A e B
  13,             // Libertadores
  11,             // Sul-Americana
];

function prioridadeLiga(ligaId) {
  const idx = LIGAS_PRIORIDADE.indexOf(ligaId);
  return idx === -1 ? 999 : idx;
}

export async function GET(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  // Sempre a data de HOJE por padrão — é isso que faz a lista "virar"
  // automaticamente no dia seguinte, sem precisar de nenhum agendamento.
  const dataParam = searchParams.get('data');
  const data = dataParam ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

  // O parâmetro "data" (se vier de algum cliente, hoje o frontend nunca
  // manda) vai direto pra URL da API-Football e pra chave de cache — exige
  // formato YYYY-MM-DD antes de usar, em vez de confiar ciegamente no que
  // veio na query string.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return NextResponse.json({ error: 'Parâmetro "data" inválido, use YYYY-MM-DD.' }, { status: 400 });
  }

  const chave = `jogos-do-dia::${data}`;
  const cacheado = await getCached(chave, CACHE_TTL_MS);
  if (cacheado) return NextResponse.json({ ...cacheado, _cache: true });

  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return NextResponse.json({ error: 'FOOTBALL_API_KEY não configurada.' }, { status: 500 });

  try {
    const res = await fetchComRetry(
      `https://v3.football.api-sports.io/fixtures?date=${data}&timezone=America/Sao_Paulo`,
      { headers: { 'x-apisports-key': key } },
      { timeoutMs: 15000 }
    );
    if (!res.ok) {
      console.error(JSON.stringify({ etapa: 'jogos-do-dia', data, status: res.status }));
      return NextResponse.json({ error: 'Falha ao buscar jogos do dia na API-Football.' }, { status: 502 });
    }

    const json = await res.json();
    const jogos = (json?.response || [])
      .map(f => ({
        id: f.fixture?.id,
        hora: f.fixture?.date,
        status: f.fixture?.status?.short || null,
        minuto: f.fixture?.status?.elapsed ?? null,
        liga: f.league?.name || 'Outra liga',
        ligaId: f.league?.id ?? null,
        pais: f.league?.country || null,
        timeA: f.teams?.home?.name || '?',
        timeB: f.teams?.away?.name || '?',
        golsA: f.goals?.home,
        golsB: f.goals?.away,
      }))
      .sort((a, b) => {
        const pa = prioridadeLiga(a.ligaId), pb = prioridadeLiga(b.ligaId);
        if (pa !== pb) return pa - pb;
        if (a.liga !== b.liga) return a.liga.localeCompare(b.liga);
        return new Date(a.hora) - new Date(b.hora);
      });

    const payload = { data, total: jogos.length, jogos };
    await setCached(chave, payload);
    return NextResponse.json(payload);
  } catch (e) {
    console.error(JSON.stringify({ etapa: 'jogos-do-dia', data, erro: e.message }));
    return NextResponse.json({ error: 'Erro ao buscar jogos do dia.' }, { status: 500 });
  }
}
