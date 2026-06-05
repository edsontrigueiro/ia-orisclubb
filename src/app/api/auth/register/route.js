export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

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
    return NextResponse.json({
      token: data.session?.access_token || null,
      user: { id: data.user.id, email: data.user.email }
    });
  } catch { return NextResponse.json({ error: 'Erro interno.' }, { status: 500 }); }
}
