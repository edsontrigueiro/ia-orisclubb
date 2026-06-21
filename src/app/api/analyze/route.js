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

async function getFootballData(jogo) {
  const key = process.env.FOOTBALL_API_KEY;
  if (!key) {
    console.error('FOOTBALL_API_KEY não configurada.');
    return '';
  }
  const headers = { 'x-apisports-key': key };
  try {
    const team = jogo.split(/\s+vs\s+|\s+x\s+/i)[0].trim();

    // 1) Descobrir o ID do time (o endpoint /fixtures não aceita busca por nome)
    const teamRes = await fetch(
      `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(team)}`,
