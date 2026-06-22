'use client';
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { saveSession } from '@/lib/clientSession';

const MSGS = {
  'sessao-expirada': 'Sua sessão expirou. Faça login novamente.',
  'confirme-email': 'Conta criada! Confirme seu e-mail antes de entrar.',
};

export default function Login() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const infoMsg = MSGS[searchParams.get('msg')] || '';

  async function submit(e) {
    e.preventDefault();
    setErr(''); setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error || 'Erro ao entrar.'); return; }
      saveSession(data);
      router.push('/app');
    } catch { setErr('Erro de conexão.'); }
    finally { setLoading(false); }
  }

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <div style={S.logo}>
          <svg width="36" height="36" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#00d084"/><stop offset="100%" stopColor="#00b4d8"/></linearGradient></defs>
            <rect x="1" y="1" width="42" height="42" rx="10" fill="url(#lg)" fillOpacity=".12"/>
            <rect x="1" y="1" width="42" height="42" rx="10" stroke="url(#lg)" strokeWidth="1.5" fill="none"/>
            <polyline points="10,31 18,21 26,26 34,13" stroke="#00d084" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            <polyline points="27,13 34,13 34,20" stroke="#00d084" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            <line x1="6" y1="35" x2="38" y2="35" stroke="#00d084" strokeWidth="1.5" strokeLinecap="round" opacity=".5"/>
            <circle cx="26" cy="35" r="2.5" fill="#00d084" opacity=".8"/>
          </svg>
          <div>
            <div style={S.brand}>Scanner<span style={{color:'#00d084'}}>Tips</span></div>
            <div style={S.brandSub}>ANÁLISE DE SINAIS COM IA</div>
          </div>
        </div>

        <div style={S.card}>
          <div style={S.cardTop}/>
          <div style={{padding:'28px 28px 24px'}}>
            <div style={S.title}>Entrar na plataforma</div>
            <div style={S.sub}>Acesse sua conta para continuar</div>

            {infoMsg && <div style={S.info}>{infoMsg}</div>}

            <form onSubmit={submit}>
              <div style={S.fgroup}>
                <label style={S.label}>E-MAIL</label>
                <input style={S.inp} type="email" placeholder="seu@email.com"
                  value={email} onChange={e=>setEmail(e.target.value)}
                  autoComplete="email" required/>
              </div>
              <div style={S.fgroup}>
                <label style={S.label}>SENHA</label>
                <div style={{position:'relative'}}>
                  <input style={{...S.inp,paddingRight:'44px'}} type={showPass?'text':'password'}
                    placeholder="••••••••" value={pass} onChange={e=>setPass(e.target.value)}
                    autoComplete="current-password" required/>
                  <button type="button" onClick={()=>setShowPass(!showPass)}
                    style={S.eyeBtn}>
                    {showPass
                      ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                      : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    }
                  </button>
                </div>
              </div>
              {err && <div style={S.err}>{err}</div>}
              <button style={{...S.btn, opacity: loading?0.7:1}} type="submit" disabled={loading}>
                {loading ? 'Entrando...' : 'Entrar no sistema →'}
              </button>
            </form>

            <div style={S.footer}>
              Não tem conta?{' '}
              <Link href="/cadastro" style={{color:'#00d084',fontWeight:600,textDecoration:'none'}}>
                Criar conta grátis
              </Link>
            </div>
          </div>
        </div>
        <div style={S.copy}>© 2025 Scanner Tips · Análise de apostas com IA</div>
      </div>
    </div>
  );
}

const S = {
  page:{minHeight:'100vh',background:'#070a08',display:'flex',alignItems:'center',justifyContent:'center',padding:'20px',fontFamily:'Inter,system-ui,sans-serif'},
  wrap:{width:'100%',maxWidth:'420px'},
  logo:{display:'flex',alignItems:'center',gap:'12px',justifyContent:'center',marginBottom:'32px'},
  brand:{fontSize:'22px',fontWeight:900,color:'#f0f5f2',letterSpacing:'-.5px'},
  brandSub:{fontSize:'9px',fontWeight:700,color:'#3d5548',letterSpacing:'2.5px',marginTop:'1px'},
  card:{background:'#0f1510',border:'1px solid rgba(0,208,132,.15)',borderRadius:'14px',overflow:'hidden',boxShadow:'0 24px 64px rgba(0,0,0,.6)'},
  cardTop:{height:'2px',background:'linear-gradient(90deg,#00d084,#00b4d8)'},
  title:{fontSize:'20px',fontWeight:800,color:'#f0f5f2',marginBottom:'5px',letterSpacing:'-.4px'},
  sub:{fontSize:'13px',color:'#5a7a6a',marginBottom:'24px'},
  fgroup:{marginBottom:'16px'},
  label:{display:'block',fontSize:'10px',fontWeight:700,color:'#3d5548',letterSpacing:'1.5px',marginBottom:'7px'},
  inp:{width:'100%',background:'#131a14',border:'1px solid rgba(255,255,255,.07)',color:'#f0f5f2',borderRadius:'8px',padding:'11px 13px',fontSize:'14px',outline:'none',boxSizing:'border-box',fontFamily:'inherit',transition:'border .18s'},
  eyeBtn:{position:'absolute',right:'12px',top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:'#5a7a6a',cursor:'pointer',padding:'2px',display:'flex',alignItems:'center'},
  err:{background:'rgba(239,68,68,.08)',border:'1px solid rgba(239,68,68,.2)',borderRadius:'8px',padding:'10px 12px',fontSize:'12.5px',color:'#f87171',marginBottom:'16px'},
  info:{background:'rgba(0,208,132,.08)',border:'1px solid rgba(0,208,132,.2)',borderRadius:'8px',padding:'10px 12px',fontSize:'12.5px',color:'#00d084',marginBottom:'16px'},
  btn:{width:'100%',background:'#00d084',color:'#000',border:'none',borderRadius:'8px',padding:'13px',fontSize:'14px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',marginTop:'4px',transition:'all .18s'},
  footer:{textAlign:'center',marginTop:'20px',fontSize:'13px',color:'#5a7a6a'},
  copy:{textAlign:'center',marginTop:'20px',fontSize:'11px',color:'#243328'},
};
