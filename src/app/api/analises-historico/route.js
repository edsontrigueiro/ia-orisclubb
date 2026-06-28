export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getSession } from '@/lib/auth';

function logErro(etapa, contexto, erro) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), etapa, ...contexto, erro: erro?.message || String(erro) }));
}

// Histórico de TODA análise real já feita (aprovada ou reprovada, pega ou
// não), pra calibrar o sistema com o universo completo, não só com o que foi
// escolhido pra apostar (isso já existe em `signals`).
export async function GET(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  const db = getSupabaseAdmin();
  const { data, error } = await db.from('analises_historico').select('*')
    .eq('user_id', session.userId).order('analisado_em', { ascending: false }).limit(500);
  if (error) { logErro('analises_historico_get', {}, error); return NextResponse.json({ error: error.message }, { status: 500 }); }
  return NextResponse.json({ analises: data });
}

// Marca o resultado real de uma análise que o usuário sabe o que aconteceu
// (ex: assistiu o jogo mesmo sem ter apostado) — é assim que sinal REJEITADO
// também entra na conta de calibração.
export async function PATCH(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  try {
    const { id, resultado } = await request.json();
    if (!id || !resultado)
      return NextResponse.json({ error: 'id e resultado obrigatórios.' }, { status: 400 });
    if (resultado !== 'green' && resultado !== 'red')
      return NextResponse.json({ error: 'resultado deve ser "green" ou "red".' }, { status: 400 });
    const db = getSupabaseAdmin();
    const { data, error } = await db.from('analises_historico')
      .update({ resultado, resultado_atualizado_em: new Date().toISOString() })
      .eq('id', id).eq('user_id', session.userId).select().single();
    if (error) { logErro('analises_historico_patch', { id, resultado }, error); return NextResponse.json({ error: error.message }, { status: 500 }); }
    return NextResponse.json({ analise: data });
  } catch (e) {
    logErro('analises_historico_patch_exception', {}, e);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}
