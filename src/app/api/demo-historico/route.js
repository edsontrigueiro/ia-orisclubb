import { NextResponse } from 'next/server';

// Rota ISOLADA de demonstracao. Nao substitui nem afeta
// src/app/api/analises-historico/route.js (rota real do sistema).
// Alimenta apenas /demo-dashboard.
const REGISTROS_DEMO = [
  {
    id: 1,
    time_a: 'Flamengo',
    time_b: 'Palmeiras',
    mercado: 'mais15',
    score: 78,
    aprovado_final: true,
    lado_aprovado: 'Casa',
    criado_em: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
  },
  {
    id: 2,
    time_a: 'Corinthians',
    time_b: 'Sao Paulo',
    mercado: 'layempate',
    score: 54,
    aprovado_final: false,
    lado_aprovado: null,
    criado_em: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
  {
    id: 3,
    time_a: 'Man City',
    time_b: 'Arsenal',
    mercado: 'under35',
    score: 82,
    aprovado_final: true,
    lado_aprovado: 'Fora',
    criado_em: new Date(Date.now() - 1000 * 60 * 60 * 9).toISOString(),
  },
  {
    id: 4,
    time_a: 'Botafogo',
    time_b: 'Fluminense',
    mercado: 'escanteios85',
    score: 61,
    aprovado_final: false,
    lado_aprovado: null,
    criado_em: new Date(Date.now() - 1000 * 60 * 60 * 14).toISOString(),
  },
  {
    id: 5,
    time_a: 'Real Madrid',
    time_b: 'Barcelona',
    mercado: 'duplachance',
    score: 91,
    aprovado_final: true,
    lado_aprovado: 'Casa',
    criado_em: new Date(Date.now() - 1000 * 60 * 60 * 20).toISOString(),
  },
];

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const mercado = searchParams.get('mercado');
    const aprovado = searchParams.get('aprovado');
    const limit = Number(searchParams.get('limit')) || 200;

    let dados = [...REGISTROS_DEMO];
    if (mercado) dados = dados.filter((r) => r.mercado === mercado);
    if (aprovado !== null && aprovado !== '') {
      const bool = aprovado === 'true';
      dados = dados.filter((r) => r.aprovado_final === bool);
    }
    dados = dados.slice(0, limit);

    return NextResponse.json({ data: dados, _demo: true });
  } catch (err) {
    return NextResponse.json(
      { error: 'Erro ao buscar historico demo', detalhe: err.message },
      { status: 500 }
    );
  }
}
