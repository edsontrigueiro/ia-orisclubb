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

// Limite inferior do intervalo de Wilson (95% de confiança) — a taxa bruta
// (greens/total) superestima sistematicamente a confiança em amostras
// pequenas. Ex: 41/47 = 87.2% bruto, mas o limite inferior de Wilson fica em
// ~74.8% — é essa segunda métrica que diz se dá pra confiar no número com
// n pequeno, não a taxa bruta sozinha. z=1.96 pra 95% de confiança.
function wilsonLowerBound(greens, total) {
  if (total === 0) return null;
  const z = 1.96;
  const p = greens / total;
  const denominador = 1 + (z * z) / total;
  const centro = p + (z * z) / (2 * total);
  const margem = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return +(((centro - margem) / denominador) * 100).toFixed(1);
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
    .select('mercado, score, aprovado, resultado, competicao, resolvido_automaticamente, sinais_fracos_count, match_exato_a, match_exato_b')
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
    .map(c => ({
      ...c,
      taxa_acerto: +((c.greens / c.total) * 100).toFixed(1),
      wilson_lower_bound: wilsonLowerBound(c.greens, c.total),
      amostra_insuficiente: c.total < 15, // mesmo piso do protocolo de calibração alinhado
    }))
    .sort((a, b) => a.mercado.localeCompare(b.mercado) || a.faixa_score.localeCompare(b.faixa_score));

  // ── Por liga/competição ──────────────────────────────────────────────────
  // SEM corte fixo de top-20: corte por volume escondia exatamente as ligas
  // de baixo volume individual mas alta concentração de red (Ykkönen,
  // Superettan, Torneo A, Canadian Premier) que motivaram o Gate 2. Em vez
  // de cortar por posição, marca min_amostra pra sinalizar ligas com poucos
  // dados (taxa não confiável) sem escondê-las do relatório.
  const porLiga = {};
  for (const d of aprovadasResolvidas) {
    const liga = d.competicao || 'Desconhecida';
    if (!porLiga[liga]) porLiga[liga] = { competicao: liga, total: 0, greens: 0 };
    porLiga[liga].total++;
    if (d.resultado === 'green') porLiga[liga].greens++;
  }
  const calibracaoPorLiga = Object.values(porLiga)
    .map(c => ({
      ...c,
      taxa_acerto: +((c.greens / c.total) * 100).toFixed(1),
      wilson_lower_bound: wilsonLowerBound(c.greens, c.total),
      amostra_pequena: c.total < 5,
    }))
    .sort((a, b) => a.taxa_acerto - b.taxa_acerto || b.total - a.total);

  // ── Por sinais_fracos_count (Gate 2) ────────────────────────────────────
  // Em análises APROVADAS, sinais_fracos_count só pode ser 0 ou 1 (>=2 é
  // reprovado automaticamente pelo Gate 2). Se taxa_acerto de
  // sinais_fracos=1 for visivelmente pior que sinais_fracos=0, é evidência
  // de que o limiar do Gate 2 (>=2 pra reprovar) está frouxo demais e
  // deveria reprovar com 1 sinal fraco já. Exclui registros antigos sem
  // esse dado (sinais_fracos_count null), gravados antes dessa coluna
  // existir — não dá pra calibrar o que não foi medido.
  const comSinais = aprovadasResolvidas.filter(d => d.sinais_fracos_count !== null && d.sinais_fracos_count !== undefined);
  const porSinaisFracos = {};
  for (const d of comSinais) {
    const k = d.sinais_fracos_count;
    if (!porSinaisFracos[k]) porSinaisFracos[k] = { sinais_fracos_count: k, total: 0, greens: 0 };
    porSinaisFracos[k].total++;
    if (d.resultado === 'green') porSinaisFracos[k].greens++;
  }
  const calibracaoPorSinaisFracos = Object.values(porSinaisFracos)
    .map(c => ({
      ...c,
      taxa_acerto: +((c.greens / c.total) * 100).toFixed(1),
      wilson_lower_bound: wilsonLowerBound(c.greens, c.total),
    }))
    .sort((a, b) => a.sinais_fracos_count - b.sinais_fracos_count);

  // Wilson lower bound do agregado geral (todos os mercados/ligas juntos) —
  // é o número que responde "dá pra confiar que a taxa real está perto do
  // que a taxa bruta mostra?" antes de qualquer decisão de ajustar
  // threshold. Ex: 41/47 aprovados green é 87.2% bruto, mas o limite
  // inferior de Wilson é o que diz se isso é estatisticamente distinguível
  // do target de calibração (95%) ou só variância de amostra pequena.
  const greensGeral = aprovadasResolvidas.filter(d => d.resultado === 'green').length;
  const wilsonGeral = wilsonLowerBound(greensGeral, aprovadasResolvidas.length);

  return NextResponse.json({
    total_analises: total,
    resolvidas: resolvidas.length,
    cobertura_pct: cobertura,
    resolvidas_automaticamente: resolvidas.filter(d => d.resolvido_automaticamente).length,
    aprovadas_resolvidas: aprovadasResolvidas.length,
    taxa_acerto_geral: aprovadasResolvidas.length
      ? +((greensGeral / aprovadasResolvidas.length) * 100).toFixed(1)
      : null,
    wilson_lower_bound_geral: wilsonGeral,
    aviso: aprovadasResolvidas.length < 30
      ? 'Amostra ainda pequena (< 30 sinais aprovados com resultado conhecido) — taxas abaixo são indicativas, não conclusivas.'
      : null,
    calibracao_por_mercado_faixa: calibracaoPorMercado,
    calibracao_por_liga: calibracaoPorLiga,
    calibracao_por_sinais_fracos: calibracaoPorSinaisFracos,
    aviso_sinais_fracos: comSinais.length === 0
      ? 'Nenhuma análise no histórico ainda tem sinais_fracos_count gravado (coluna nova) — essa quebra só populará daqui pra frente.'
      : null,
  });
}
