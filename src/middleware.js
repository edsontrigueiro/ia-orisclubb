import { NextResponse } from 'next/server';

export function middleware(request) {
  const { pathname } = request.nextUrl;
  
  // Skip API routes and static files
  if (pathname.startsWith('/api/') || 
      pathname.startsWith('/_next/') ||
      pathname.includes('.')) {
    return NextResponse.next();
  }

  const token = request.cookies.get('st_token')?.value;
  
  // Auth pages - redirect to app if already logged in
  if (pathname === '/login' || pathname === '/cadastro') {
    if (token) return NextResponse.redirect(new URL('/app', request.url));
    return NextResponse.next();
  }
  
  // Protected pages - redirect to login if not authenticated
  if (pathname.startsWith('/app')) {
    if (!token) return NextResponse.redirect(new URL('/login', request.url));
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
