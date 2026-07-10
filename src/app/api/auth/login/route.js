export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { setSessionCookies } from '@/lib/authCookies';

export async function POST(request) {
  try {
    const { email, password } = await request.json();
    if (!email || !password)
      return NextResponse.json({ error: 'E-mail e senha obrigatórios.' }, { status: 400 });
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return NextResponse.json({ error: 'E-mail ou senha incorretos.' }, { status: 401 });

    // O access_token e o refresh_token NÃO vão mais no corpo da resposta —
    // só como cookie httpOnly (ver authCookies.js). O client não tem
    // acesso a nenhum dos dois via JS, o que fecha o vetor de roubo de
    // sessão via XSS que existia antes (token ficava em localStorage).
    const response = NextResponse.json({
      user: { id: data.user.id, email: data.user.email },
    });
    setSessionCookies(response, data.session);
    return response;
  } catch { return NextResponse.json({ error: 'Erro interno.' }, { status: 500 }); }
}
