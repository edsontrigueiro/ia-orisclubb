import { getSupabaseAdmin } from './supabase';

// Cache genérico em Supabase (tabela "analise_cache"), reutilizado por
// qualquer rota que precise guardar um resultado por um tempo (análise de
// jogo, grade de jogos do dia, etc). Cada chamador define sua própria chave
// e TTL. Falha em silêncio se a tabela não existir — cache é otimização,
// nunca deve impedir a funcionalidade normal.
export async function getCached(chave, ttlMs) {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from('analise_cache')
      .select('payload, created_at')
      .eq('chave', chave)
      .maybeSingle();
    if (error || !data) return null;
    const idade = Date.now() - new Date(data.created_at).getTime();
    if (idade > ttlMs) return null;
    return data.payload;
  } catch (e) {
    console.error(JSON.stringify({ etapa: 'getCached', chave, erro: e.message }));
    return null;
  }
}

export async function setCached(chave, payload) {
  try {
    const db = getSupabaseAdmin();
    await db.from('analise_cache').upsert({
      chave,
      payload,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error(JSON.stringify({ etapa: 'setCached', chave, erro: e.message }));
  }
}
