import { getSupabase } from './supabase';

export async function getSession(request) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '') ||
    request.cookies?.get?.('st_token')?.value;
  if (!token) return null;
  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return { userId: user.id, email: user.email };
  } catch { return null; }
}
