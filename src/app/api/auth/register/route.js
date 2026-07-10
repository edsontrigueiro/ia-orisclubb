export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { setSessionCookies } from '@/lib/authCookies';

export async function POST(request) {
  try {
    const { email, password, name } = await request.json();
    if (!email || !password || !name)
      return NextResponse.json({ error: 'Preencha todos os campos.' }, { status: 400 });
    if (password.length < 6)
      return NextResponse.json({ error: 'Senha mínimo 6 caracteres.' }, { status: 400 });
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { full_name: name } }
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });

    // Se o projeto Supabase exigir confirmação de e-mail, data.session vem
    // null aqui — não tem sessão pra criar cookie ainda, o usuário só loga
    // depois de confirmar. "sessaoCriada" substitui o antigo check
    // "if (data.token)" que o frontend fazia pra decidir isso — o token em
    // si não existe mais no corpo da resposta.
    const response = NextResponse.json({
      user: { id: data.user.id, email: data.user.email },
      sessaoCriada: !!data.session,
    });
    if (data.session) setSessionCookies(response, data.session);
    return response;
  } catch { return NextResponse.json({ error: 'Erro interno.' }, { status: 500 }); }
}
