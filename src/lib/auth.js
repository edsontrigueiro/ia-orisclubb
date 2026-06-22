import { getSupabase } from './supabase';

export async function getSession(request) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '') ||
    request.cookies?.get?.('st_token')?.value;
  if (!token) {
    console.error('getSession: nenhum token recebido (header Authorization ou cookie st_token ausentes)');
    return null;
  }
  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      console.error('getSession: token rejeitado pelo Supabase —', error?.message || 'usuário não encontrado');
      return null;
    }
    return { userId: user.id, email: user.email };
  } catch (e) {
    console.error('getSession exception:', e.message);
    return null;
  }
}
