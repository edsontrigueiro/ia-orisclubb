export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { setSessionCookies, clearSessionCookies } from '@/lib/authCookies';

export async function POST(request) {
  try {
    // O refresh_token vem do cookie httpOnly (st_refresh), não mais do
    // corpo da requisição — o client não tem acesso a ele pra mandar de
    // volta, e não precisa: o cookie já vai junto automaticamente em
    // qualquer chamada same-origin.
    const refresh_token = request.cookies.get('st_refresh')?.value;
    if (!refresh_token)
      return NextResponse.json({ error: 'Sessão expirada. Faça login novamente.' }, { status: 401 });

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.refreshSession({ refresh_token });

    if (error || !data?.session) {
      console.error('refresh error:', error?.message || 'sessão ausente na resposta');
      const response = NextResponse.json({ error: 'Sessão expirada. Faça login novamente.' }, { status: 401 });
      // Refresh_token que falhou está morto de qualquer forma — limpa os
      // cookies pra não ficar tentando de novo em toda chamada.
      clearSessionCookies(response);
      return response;
    }

    const response = NextResponse.json({
      user: { id: data.user.id, email: data.user.email },
    });
    setSessionCookies(response, data.session);
    return response;
  } catch (e) {
    console.error('refresh exception:', e.message);
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 });
  }
}
