'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { saveSession } from '@/lib/clientSession';
import { C, FONT_DISPLAY, FONT_BODY } from '@/lib/theme';

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
      if (data.sessaoCriada) {
        saveSession(data);
        router.push('/app');
      } else {
        router.push('/login?msg=confirme-email');
      }
    } catch { setErr('Erro de conexão.'); }
    finally { setLoading(false); }
  }

  return (
    <div style={S.page}>
      <div style={S.wrap}>
        <div style={S.logo}>
          <svg width="38" height="38" viewBox="0 0 44 44" fill="none">
            <rect x="1" y="1" width="42" height="42" rx="11" fill={C.orangeDim} stroke={C.orange} strokeWidth="1.5"/>
            <circle cx="22" cy="22" r="11" fill="none" stroke={C.orange} strokeWidth="2.2" strokeDasharray="52 17" strokeLinecap="round" transform="rotate(-90 22 22)"/>
            <circle cx="22" cy="11" r="2" fill={C.orange}/>
          </svg>
          <div>
            <div style={S.brand}>ORIS<span style={{color:C.orange}}> CLUB</span></div>
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
              <Link href="/login" style={{color:C.orange,fontWeight:600,textDecoration:'none'}}>
                Entrar
              </Link>
            </div>
          </div>
        </div>
        <div style={S.copy}>© 2026 Oris Club · Análise de apostas com IA</div>
      </div>
    </div>
  );
}

const S = {
  page:{minHeight:'100vh',background:C.bg,display:'flex',alignItems:'center',justifyContent:'center',padding:'20px',fontFamily:FONT_BODY},
  wrap:{width:'100%',maxWidth:'420px'},
  logo:{display:'flex',alignItems:'center',gap:'12px',justifyContent:'center',marginBottom:'32px'},
  brand:{fontSize:'22px',fontWeight:800,color:C.text,letterSpacing:'-.3px',fontFamily:FONT_DISPLAY},
  brandSub:{fontSize:'9px',fontWeight:700,color:C.muted2,letterSpacing:'2.5px',marginTop:'2px'},
  card:{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'14px',overflow:'hidden',boxShadow:'0 24px 64px rgba(0,0,0,.6)'},
  cardTop:{height:'2px',background:`linear-gradient(90deg,${C.orange},${C.orangeGlow})`},
  title:{fontSize:'20px',fontWeight:700,color:C.text,marginBottom:'5px',letterSpacing:'-.3px',fontFamily:FONT_DISPLAY},
  sub:{fontSize:'13px',color:C.muted,marginBottom:'24px'},
  fgroup:{marginBottom:'16px'},
  label:{display:'block',fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'1.5px',marginBottom:'7px'},
  inp:{width:'100%',background:C.bg4,border:`1px solid ${C.border}`,color:C.text,borderRadius:'8px',padding:'11px 13px',fontSize:'14px',outline:'none',boxSizing:'border-box',fontFamily:'inherit'},
  err:{background:C.redDim,border:`1px solid rgba(255,77,77,.25)`,borderRadius:'8px',padding:'10px 12px',fontSize:'12.5px',color:C.red,marginBottom:'16px'},
  btn:{width:'100%',background:C.orange,color:'#0A0A0A',border:'none',borderRadius:'8px',padding:'13px',fontSize:'14px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',marginTop:'4px'},
  footer:{textAlign:'center',marginTop:'20px',fontSize:'13px',color:C.muted},
  copy:{textAlign:'center',marginTop:'20px',fontSize:'11px',color:C.muted3},
};
