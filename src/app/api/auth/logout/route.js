export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { clearSessionCookies } from '@/lib/authCookies';

// Rota nova. Necessária porque cookie httpOnly não pode ser apagado via
// document.cookie pelo client (por definição — JS não enxerga esse
// cookie) — só o próprio servidor consegue instruir o browser a apagá-lo,
// via header Set-Cookie com maxAge 0.
export async function POST() {
  const response = NextResponse.json({ ok: true });
  clearSessionCookies(response);
  return response;
}
