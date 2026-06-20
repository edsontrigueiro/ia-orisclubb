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
    resumo: 'Configure ANTHROPIC_API_KEY e RAPIDAPI_KEY para análise real com IA e dados ao vivo.',
    _minScore: min,
    _demo: true,
  };
}

async function getFootballData(jogo) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return '';
  try {
    const team = jogo.split(/\s+vs\s+|\s+x\s+/i)[0].trim();
    const res = await fetch(
      `https://api-football-v1.p.rapidapi.com/v3/fixtures?search=${encodeURIComponent(team)}&next=5`,
      { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'api-football-v1.p.rapidapi.com' } }
    );
    const d = await res.json();
    const fixture = d?.response?.[0];
    if (!fixture) return '';
    return `\nDados API-Football: ${JSON.stringify(fixture).slice(0, 500)}`;
  } catch { return ''; }
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
    const extraCtx = await getFootballData(jogo);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
       model: 'claude-haiku-4-5-20251001',
        max_tokens: 900,
        messages: [{
          role: 'user',
          content: `Analise "${jogo}" para o mercado "${mercado}". Score mínimo para aprovar: ${min}/100.${extraCtx}

Responda SOMENTE JSON válido sem markdown:
{"evento":"nome formatado","competicao":"liga","score":0-100,"aprovado":bool,"odds_estimada":"1.XX","probabilidade_real":0-100,"criterios_atendidos":["..."],"criterios_nao_atendidos":["..."],"alertas":[],"insight":"frase curta explicando score","resumo":"2-3 frases operacionais para o trader"}`
        }]
      }),
    });

    if (!res.ok) {
      console.error('Anthropic error:', res.status);
      return NextResponse.json(demoResult(jogo, mercado));
    }

    const data = await res.json();
    const text = data.content?.[0]?.text?.replace(/```json|```/g, '').trim();
    if (!text) return NextResponse.json(demoResult(jogo, mercado));

    const result = JSON.parse(text);
    result._minScore = min;
    return NextResponse.json(result);

  } catch (e) {
    console.error('analyze error:', e.message);
    const body = await request.clone().json().catch(() => ({}));
    return NextResponse.json(demoResult(body.jogo || 'Jogo', body.mercado || 'Lay 2x2'));
  }
}
