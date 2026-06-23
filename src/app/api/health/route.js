export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

// Endpoint leve pra mostrar no topo do app se as duas APIs externas estão
// saudáveis, em vez de só descobrir que algo quebrou quando uma análise sai
// estranha. /status da API-Football é gratuito e não consome quota — feito
// exatamente pra esse tipo de checagem.
export async function GET(request) {
  const session = await getSession(request);
  if (!session) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });

  const footballKey = process.env.FOOTBALL_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  let football = { ok: false, configurada: !!footballKey, motivo: null, requestsUsadas: null, requestsLimite: null };

  if (footballKey) {
    try {
      const res = await fetch('https://v3.football.api-sports.io/status', {
        headers: { 'x-apisports-key': footballKey },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        const acc = data?.response;
        football.ok = true;
        football.requestsUsadas = acc?.requests?.current ?? null;
        football.requestsLimite = acc?.requests?.limit_day ?? null;
        football.plano = acc?.subscription?.plan ?? null;
      } else {
        football.motivo = `API respondeu ${res.status}`;
      }
    } catch (e) {
      football.motivo = e.message;
    }
  } else {
    football.motivo = 'FOOTBALL_API_KEY não configurada';
  }

  // Não dá pra checar a validade da key da Anthropic sem gastar uma chamada
  // de geração de verdade — então aqui só confirmamos que a variável existe,
  // não que ela é válida. É uma checagem parcial, mas honesta.
  const anthropic = {
    ok: !!anthropicKey,
    configurada: !!anthropicKey,
    motivo: anthropicKey ? null : 'ANTHROPIC_API_KEY não configurada',
  };

  return NextResponse.json({ football, anthropic, checadoEm: new Date().toISOString() });
}
