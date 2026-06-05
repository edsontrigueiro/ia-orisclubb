'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function Cadastro() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function submit(e) {
    e.preventDefault();
    setErr(''); setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass, name }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error || 'Erro ao criar conta.'); return; }
      if (data.token) {
        document.cookie = `st_token=${data.token}; path=/; max-age=${7*24*3600}; SameSite=Lax`;
        localStorage.setItem('st_token', data.token);
        localStorage.setItem('st_user', JSON.stringify(data.user));
        router.push('/app');
      } else {
        // Email confirmation required
        router.push('/login?msg=confirme-email');
      }
    } catch { setErr('Erro de conexão.'); }
    finally { setLoading(false); }
  }

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <div style={S.logo}>
          <svg width="36" height="36" viewBox="0 0 44 44" fill="none">
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
            <div style={S.title}>Criar conta</div>
            <div style={S.sub}>Comece a registrar seus sinais agora</div>

            <form onSubmit={submit}>
              <div style={S.fgroup}>
                <label style={S.label}>NOME COMPLETO</label>
                <input style={S.inp} type="text" placeholder="Seu nome"
                  value={name} onChange={e=>setName(e.target.value)}
                  autoComplete="name" required/>
              </div>
              <div style={S.fgroup}>
                <label style={S.label}>E-MAIL</label>
                <input style={S.inp} type="email" placeholder="seu@email.com"
                  value={email} onChange={e=>setEmail(e.target.value)}
                  autoComplete="email" required/>
              </div>
              <div style={S.fgroup}>
                <label style={S.label}>SENHA</label>
                <input style={S.inp} type="password" placeholder="Mínimo 6 caracteres"
                  value={pass} onChange={e=>setPass(e.target.value)}
                  autoComplete="new-password" required minLength={6}/>
              </div>
              {err && <div style={S.err}>{err}</div>}
              <button style={{...S.btn, opacity:loading?0.7:1}} type="submit" disabled={loading}>
                {loading ? 'Criando conta...' : 'Criar conta grátis →'}
              </button>
            </form>

            <div style={S.footer}>
              Já tem conta?{' '}
              <Link href="/login" style={{color:'#00d084',fontWeight:600,textDecoration:'none'}}>
                Entrar
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
  inp:{width:'100%',background:'#131a14',border:'1px solid rgba(255,255,255,.07)',color:'#f0f5f2',borderRadius:'8px',padding:'11px 13px',fontSize:'14px',outline:'none',boxSizing:'border-box',fontFamily:'inherit'},
  err:{background:'rgba(239,68,68,.08)',border:'1px solid rgba(239,68,68,.2)',borderRadius:'8px',padding:'10px 12px',fontSize:'12.5px',color:'#f87171',marginBottom:'16px'},
  btn:{width:'100%',background:'#00d084',color:'#000',border:'none',borderRadius:'8px',padding:'13px',fontSize:'14px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',marginTop:'4px'},
  footer:{textAlign:'center',marginTop:'20px',fontSize:'13px',color:'#5a7a6a'},
  copy:{textAlign:'center',marginTop:'20px',fontSize:'11px',color:'#243328'},
};
