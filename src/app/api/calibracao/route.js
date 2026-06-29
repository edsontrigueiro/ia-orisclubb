export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

function logErro(etapa, contexto, erro) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), etapa, ...contexto, erro: erro?.message || String(erro) }));
}

function faixaScore(score) {
  const base = Math.floor(score / 5) * 5;
  return `${base}-${base + 4}`;
}

// Relatório de calibração real: compara o "score" que o sistema deu com a
// taxa de acerto de fato observada (campo "resultado", preenchido manual ou
// automaticamente pelo cron). Sem isso, ninguém sabe se "score 88" de fato
// significa ~88% de acerto ou se o sistema está sistematicamente otimista
// ou pessimista — esse é o número que falta pra qualquer decisão de reajuste
// de threshold ter base em dado real, não em achismo.
export async function GET(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const db = getSupabaseAdmin();
  const { data, error } = await db.from('analises_historico')
    .select('mercado, score, aprovado, resultado, competicao, resolvido_automaticamente')
    .eq('user_id', session.userId)
    .order('analisado_em', { ascending: false })
    .limit(5000);

  if (error) {
    logErro('calibracao_select', {}, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const total = data.length;
  const resolvidas = data.filter(d => d.resultado === 'green' || d.resultado === 'red');
  const cobertura = total ? +((resolvidas.length / total) * 100).toFixed(1) : 0;

  // Só análises onde a IA de fato aprovou são relevantes pra "esse sinal
  // teria batido?" — sinal reprovado não tem expectativa de acerto pra
  // comparar (foi descartado de propósito).
  const aprovadasResolvidas = resolvidas.filter(d => d.aprovado);

  // ── Por mercado + faixa de score ────────────────────────────────────────
  const porMercadoFaixa = {};
  for (const d of aprovadasResolvidas) {
    const chave = `${d.mercado}::${faixaScore(d.score)}`;
    if (!porMercadoFaixa[chave]) {
      porMercadoFaixa[chave] = { mercado: d.mercado, faixa_score: faixaScore(d.score), total: 0, greens: 0 };
    }
    porMercadoFaixa[chave].total++;
    if (d.resultado === 'green') porMercadoFaixa[chave].greens++;
  }
  const calibracaoPorMercado = Object.values(porMercadoFaixa)
    .map(c => ({ ...c, taxa_acerto: +((c.greens / c.total) * 100).toFixed(1) }))
    .sort((a, b) => a.mercado.localeCompare(b.mercado) || a.faixa_score.localeCompare(b.faixa_score));

  // ── Por liga/competição (top 20 por volume) ─────────────────────────────
  const porLiga = {};
  for (const d of aprovadasResolvidas) {
    const liga = d.competicao || 'Desconhecida';
    if (!porLiga[liga]) porLiga[liga] = { competicao: liga, total: 0, greens: 0 };
    porLiga[liga].total++;
    if (d.resultado === 'green') porLiga[liga].greens++;
  }
  const calibracaoPorLiga = Object.values(porLiga)
    .map(c => ({ ...c, taxa_acerto: +((c.greens / c.total) * 100).toFixed(1) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

  return NextResponse.json({
    total_analises: total,
    resolvidas: resolvidas.length,
    cobertura_pct: cobertura,
    resolvidas_automaticamente: resolvidas.filter(d => d.resolvido_automaticamente).length,
    aprovadas_resolvidas: aprovadasResolvidas.length,
    aviso: aprovadasResolvidas.length < 30
      ? 'Amostra ainda pequena (< 30 sinais aprovados com resultado conhecido) — taxas abaixo são indicativas, não conclusivas.'
      : null,
    calibracao_por_mercado_faixa: calibracaoPorMercado,
    calibracao_por_liga: calibracaoPorLiga,
  });
}
