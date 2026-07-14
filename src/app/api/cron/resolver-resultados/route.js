export const dynamic = 'force-dynamic';
export const maxDuration = 60;
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { fetchComRetry } from '@/lib/fetchUtil';
import { buscarEscanteiosJogo } from '@/lib/footballData';
import { avaliarResultadoMercado } from '@/lib/resultadoMercado';

function logErro(etapa, contexto, erro) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), etapa, ...contexto, erro: erro?.message || String(erro) }));
}

// Roda 1x/dia via Vercel Cron (ver vercel.json). Busca toda análise aprovada
// ou reprovada que já tem jogo encerrado (>= 3h desde o horário do jogo, pra
// dar tempo de virar "FT") e ainda não tem "resultado" marcado, busca o
// placar real na API-Football e decide green/red sozinho — fecha o loop de
// calibração sem depender de ninguém clicar em nada. Sem isso, a tabela
// analises_historico nunca teria amostra grande o suficiente de "resultado"
// pra dizer algo confiável sobre a assertividade real do sistema.
export async function GET(request) {
  // Vercel injeta esse header automaticamente quando CRON_SECRET está
  // configurado nas env vars do projeto — qualquer outra chamada (sem saber
  // o secret) é rejeitada, já que /api/* não passa pelo middleware de
  // sessão de usuário.
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  }

  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return NextResponse.json({ error: 'FOOTBALL_API_KEY não configurada.' }, { status: 500 });
  const headers = { 'x-apisports-key': key };
  const db = getSupabaseAdmin();

  const limiteHorario = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

  const { data: pendentes, error: erroSelect } = await db.from('analises_historico')
    .select('id, mercado, fixture_id, data_jogo, lado_aprovado')
    .is('resultado', null)
    .not('fixture_id', 'is', null)
    .lte('data_jogo', limiteHorario)
    .order('data_jogo', { ascending: true })
    .limit(200);

  if (erroSelect) {
    logErro('cron_resolver_select', {}, erroSelect);
    return NextResponse.json({ error: erroSelect.message }, { status: 500 });
  }

  let resolvidos = 0, semDadoSuficiente = 0, jogoNaoFinalizado = 0, erros = 0;

  for (const analise of pendentes || []) {
    try {
      const res = await fetchComRetry(
        `https://v3.football.api-sports.io/fixtures?id=${analise.fixture_id}`,
        { headers }
      );
      if (!res.ok) { erros++; continue; }
      const data = await res.json();
      const f = data?.response?.[0];
      if (!f) { erros++; continue; }

      // Só resolve jogo de fato encerrado. PST/CANC/ABD/INT ficam pendentes
      // pra sempre (não tem placar válido) — não é erro, é estado esperado
      // de uma fração pequena dos jogos.
      const status = f.fixture?.status?.short;
      if (!['FT', 'AET', 'PEN'].includes(status)) {
        jogoNaoFinalizado++;
        continue;
      }

      // CORREÇÃO (auditoria jul/2026): mercados de aposta liquidam nos 90
      // MINUTOS, mas em jogos decididos na prorrogação (AET) ou nos pênaltis
      // (PEN) o campo "goals" da API-Football INCLUI os gols da prorrogação.
      // Um mata-mata 0x0 no tempo normal que termina 1x0 na prorrogação era
      // marcado green em "+0.5 Gols" quando a aposta real foi red — e cada
      // resolução errada dessas envenena a calibração que decide os
      // thresholds. "score.fulltime" é o placar ao fim dos 90 minutos, que é
      // o que interessa; pra FT normal, goals e fulltime são idênticos.
      const ehProrrogacao = status === 'AET' || status === 'PEN';
      const golsA = ehProrrogacao ? (f.score?.fulltime?.home ?? null) : (f.goals?.home ?? null);
      const golsB = ehProrrogacao ? (f.score?.fulltime?.away ?? null) : (f.goals?.away ?? null);
      const golsA1T = f.score?.halftime?.home ?? null;
      const golsB1T = f.score?.halftime?.away ?? null;

      // Escanteio vive num endpoint separado (por partida) — só busca
      // quando o mercado da análise de fato precisa disso. Em jogo com
      // prorrogação, o endpoint de estatísticas soma os escanteios dos 120
      // minutos sem como separar os 90 regulamentares — resolver com esse
      // número seria chutar. Deixa pendente (null) de propósito: melhor
      // sem resultado do que com resultado errado na calibração.
      let corners = null;
      if (analise.mercado === '+8.5 Escanteios' && !ehProrrogacao) {
        corners = await buscarEscanteiosJogo(analise.fixture_id, headers);
      }

      const resultado = avaliarResultadoMercado(analise.mercado, {
        golsA, golsB, golsA1T, golsB1T, corners, ladoAprovado: analise.lado_aprovado,
      });

      // null = dado insuficiente pra decidir com segurança (ex: Dupla
      // Chance sem lado_aprovado salvo, ou 1T sem placar de intervalo).
      // Nunca grava um green/red de palpite — fica pendente até a próxima
      // rodada ou pra sempre, se o dado realmente não existir.
      if (resultado == null) { semDadoSuficiente++; continue; }

      const { error: erroUpdate } = await db.from('analises_historico')
        .update({
          resultado,
          resultado_atualizado_em: new Date().toISOString(),
          resolvido_automaticamente: true,
        })
        .eq('id', analise.id);

      if (erroUpdate) { logErro('cron_resolver_update', { id: analise.id }, erroUpdate); erros++; continue; }
      resolvidos++;
    } catch (e) {
      logErro('cron_resolver_item', { id: analise.id }, e);
      erros++;
    }
  }

  return NextResponse.json({
    total_pendentes: (pendentes || []).length,
    resolvidos,
    sem_dado_suficiente: semDadoSuficiente,
    jogo_nao_finalizado: jogoNaoFinalizado,
    erros,
  });
}
