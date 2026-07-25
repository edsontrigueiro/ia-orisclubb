'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { saveSession } from '@/lib/clientSession';
import { C, FONT_DISPLAY, FONT_BODY, FONT_MONO, LOGO_SRC } from '@/lib/theme';

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
      {/* Movimento sóbrio, mesmo padrão do painel (playbook cap. 05) */}
      <style>{`
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        .fade-up{animation:fadeUp .3s cubic-bezier(.4,0,.2,1) both;animation-delay:var(--d,0ms)}
        input{transition:border-color .16s ease, box-shadow .16s ease}
        input:focus{border-color:${C.orangeBorder}!important;box-shadow:0 0 0 3px ${C.orangeDim}}
        button{transition:opacity .14s ease, transform .1s ease}
        button:active{transform:scale(.99)}
        @media(prefers-reduced-motion:reduce){.fade-up{animation:none}button:active{transform:none}}
      `}</style>
      <div style={S.wrap} className="fade-up">
        <div style={S.logo}>
          {/* Logo original do Brand Content Playbook — mesma marca da landing */}
          <img src={LOGO_SRC} alt="Oris Club" style={{height:'34px',width:'auto',display:'block'}}/>
          <div style={S.brandSub}>// Camada de inteligência</div>
        </div>

        <div style={S.card} className="fade-up">
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
        <div style={S.copy}>© 2026 Oris Club · Infraestrutura para operações esportivas</div>
      </div>
    </div>
  );
}

const S = {
  page:{minHeight:'100vh',background:C.bg,display:'flex',alignItems:'center',justifyContent:'center',padding:'20px',fontFamily:FONT_BODY},
  wrap:{width:'100%',maxWidth:'420px'},
  logo:{display:'flex',flexDirection:'column',alignItems:'center',gap:'10px',justifyContent:'center',marginBottom:'34px'},
  brand:{fontSize:'22px',fontWeight:900,color:C.text,letterSpacing:'-.01em',textTransform:'uppercase',fontFamily:FONT_DISPLAY},
  brandSub:{fontFamily:FONT_MONO,fontSize:'10px',fontWeight:500,color:C.muted2,letterSpacing:'2.5px',textTransform:'uppercase'},
  card:{background:C.bg2,border:`1px solid ${C.border}`,borderRadius:0,overflow:'hidden'},
  cardTop:{height:'2px',background:C.orange},
  title:{fontSize:'21px',fontWeight:900,color:C.text,marginBottom:'6px',letterSpacing:'-.01em',textTransform:'uppercase',fontFamily:FONT_DISPLAY},
  sub:{fontSize:'13px',color:C.muted,marginBottom:'24px'},
  fgroup:{marginBottom:'16px'},
  label:{display:'block',fontFamily:FONT_MONO,fontSize:'10px',fontWeight:500,color:C.muted2,letterSpacing:'1.8px',marginBottom:'8px'},
  inp:{width:'100%',background:C.bg3,border:`1px solid ${C.border}`,color:C.text,borderRadius:0,padding:'11px 13px',fontSize:'14px',outline:'none',boxSizing:'border-box',fontFamily:'inherit'},
  err:{background:C.redDim,border:`1px solid rgba(255,77,77,.25)`,borderRadius:'2px',padding:'10px 12px',fontSize:'12.5px',color:C.red,marginBottom:'16px'},
  btn:{width:'100%',background:C.orange,color:'#0A0A0A',border:'none',borderRadius:0,padding:'14px',fontSize:'13px',fontWeight:800,textTransform:'uppercase',letterSpacing:'.04em',cursor:'pointer',fontFamily:FONT_DISPLAY,marginTop:'6px',boxShadow:'4px 4px 0 #000'},
  footer:{textAlign:'center',marginTop:'20px',fontSize:'13px',color:C.muted},
  copy:{textAlign:'center',marginTop:'20px',fontSize:'11px',color:C.muted3},
};
