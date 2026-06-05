export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getSession } from '@/lib/auth';

export async function GET(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  const db = getSupabaseAdmin();
  const { data, error } = await db.from('signals').select('*')
    .eq('user_id', session.userId).order('analisado_em', { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ signals: data });
}

export async function POST(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  try {
    const { evento, competicao, mercado, score, criterios_ok, criterios_no,
            insight, resumo, decisao, odd, stake } = await request.json();
    if (!evento || !mercado || !decisao)
      return NextResponse.json({ error: 'Campos obrigatórios ausentes.' }, { status: 400 });
    const lucro_potencial = decisao === 'pegar' && odd && stake
      ? parseFloat(((stake * odd) - stake).toFixed(2)) : null;
    const db = getSupabaseAdmin();
    const { data, error } = await db.from('signals').insert({
      user_id: session.userId, evento, competicao, mercado, score,
      criterios_ok: criterios_ok || [], criterios_no: criterios_no || [],
      insight, resumo, decisao,
      odd: odd ? parseFloat(odd) : null,
      stake: stake ? parseFloat(stake) : null,
      lucro_potencial
    }).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ signal: data });
  } catch { return NextResponse.json({ error: 'Erro interno.' }, { status: 500 }); }
}

export async function PATCH(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  try {
    const { id, resultado } = await request.json();
    if (!id || !resultado)
      return NextResponse.json({ error: 'id e resultado obrigatórios.' }, { status: 400 });
    const db = getSupabaseAdmin();
    const { data: sig } = await db.from('signals').select('stake,odd')
      .eq('id', id).eq('user_id', session.userId).single();
    let lucro_real = null;
    if (sig?.stake && sig?.odd) {
      lucro_real = resultado === 'green'
        ? parseFloat(((sig.stake * sig.odd) - sig.stake).toFixed(2))
        : -parseFloat(sig.stake);
    }
    const { data, error } = await db.from('signals')
      .update({ resultado, lucro_real, atualizado_em: new Date().toISOString() })
      .eq('id', id).eq('user_id', session.userId).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ signal: data });
  } catch { return NextResponse.json({ error: 'Erro interno.' }, { status: 500 }); }
}
