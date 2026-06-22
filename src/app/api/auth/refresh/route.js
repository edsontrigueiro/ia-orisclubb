export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export async function POST(request) {
  try {
    const { refresh_token } = await request.json();
    if (!refresh_token)
      return NextResponse.json({ error: 'refresh_token obrigatório.' }, { status: 400 });

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.refreshSession({ refresh_token });

    if (error || !data?.session) {
      console.error('refresh error:', error?.message || 'sessão ausente na resposta');
      return NextResponse.json({ error: 'Sessão expirada. Faça login novamente.' }, { status: 401 });
    }

    return NextResponse.json({
      token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: { id: data.user.id, email: data.user.email },
    });
  } catch (e) {
    console.error('refresh exception:', e.message);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}
