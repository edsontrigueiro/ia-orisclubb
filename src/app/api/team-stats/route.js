export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getCached, setCached } from '@/lib/cache';
import { getFootballData } from '@/lib/footballData';

// Cache de 6h — forma recente e H2H não mudam de hora em hora, então não
// vale gastar chamada de API-Football de novo se o usuário abrir o preview
// do mesmo jogo mais de uma vez no mesmo dia.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function chaveCache(jogo) {
  return `stats::${jogo.trim().toLowerCase()}`;
}

// Endpoint só de DADOS (sem chamada de IA) — pro botão "Ver estatísticas" na
// grade do dia. Mostra forma recente, confrontos diretos e escanteios sem
// gastar nenhuma chamada à Anthropic, e sem precisar de um mercado escolhido.
export async function GET(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const jogo = searchParams.get('jogo');
  if (!jogo || typeof jogo !== 'string') {
    return NextResponse.json({ error: 'Parâmetro "jogo" obrigatório.' }, { status: 400 });
  }

  const cacheado = await getCached(chaveCache(jogo), CACHE_TTL_MS);
  if (cacheado) return NextResponse.json({ ...cacheado, _cache: true });

  try {
    // incluirEscanteios:true sempre aqui — diferente da análise, esse preview
    // existe justamente pra mostrar "escanteio, média de gols e assim por
    // diante" de uma vez, então vale o custo extra dessa chamada.
    const dados = await getFootballData(jogo, { incluirEscanteios: true });
    if (!dados.disponivel) {
      return NextResponse.json({ error: dados.motivo || 'Dados indisponíveis para esse confronto.' }, { status: 404 });
    }
    await setCached(chaveCache(jogo), dados);
    return NextResponse.json(dados);
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), etapa: 'team-stats', jogo, erro: e.message }));
    return NextResponse.json({ error: 'Erro ao buscar estatísticas.' }, { status: 500 });
  }
}
