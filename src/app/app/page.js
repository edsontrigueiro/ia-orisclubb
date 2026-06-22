'use client';
export const dynamic = 'force-dynamic';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

// ── DESIGN TOKENS ──
const C = {
  bg:'#070a08', bg2:'#0b0f0c', bg3:'#0f1510', bg4:'#131a14',
  g:'#00d084', g2:'#00ff9f', blue:'#3b82f6', orange:'#f59e0b',
  red:'#ef4444', purple:'#8b5cf6',
  text:'#f0f5f2', muted:'#5a7a6a', muted2:'#3d5548', muted3:'#243328',
  border:'rgba(255,255,255,.07)', border2:'rgba(0,208,132,.2)',
};

const MKTS = [
  { id:'lay2x2',   label:'Lay 2x2',      min:82, color:C.g },
  { id:'layzebra', label:'Lay Zebra',     min:85, color:C.g },
  { id:'mais15',   label:'+1.5 Gols',    min:83, color:C.blue },
  { id:'mais05',   label:'+0.5 Gols',    min:88, color:C.g },
  { id:'tenis',    label:'Tênis',         min:84, color:C.purple },
  { id:'menos25',  label:'-2.5 Gols 1T', min:86, color:C.orange },
];

function fmt(v) { return v?.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) ?? '—'; }

export default function App() {
  const router = useRouter();
  const [tab, setTab] = useState('analises');
  const [user, setUser] = useState(null);
  const [token, setToken] = useState('');

  // Análises state
  const [jogo, setJogo] = useState('');
  const [mkt, setMkt] = useState('Lay 2x2');
  const [stake, setStake] = useState('');
  const [odd, setOdd] = useState('');
  const [decisao, setDecisao] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Histórico state
  const [signals, setSignals] = useState([]);
  const [loadingSignals, setLoadingSignals] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);

  useEffect(() => {
    const t = localStorage.getItem('st_token');
    const u = localStorage.getItem('st_user');
    if (!t) { router.push('/login'); return; }
    setToken(t);
    if (u) try { setUser(JSON.parse(u)); } catch {}
  }, [router]);

  useEffect(() => {
    if (token && tab === 'historico') loadSignals();
    if (token && tab === 'desempenho') loadSignals();
  }, [tab, token]);

  const loadSignals = useCallback(async () => {
    if (!token) return;
    setLoadingSignals(true);
    try {
      const res = await fetch('/api/signals', { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.signals) setSignals(data.signals);
    } catch {} finally { setLoadingSignals(false); }
  }, [token]);

  async function analyze() {
    if (!jogo.trim()) return;
    setAnalyzing(true); setResult(null); setDecisao(null); setSaved(false);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jogo, mercado: mkt }),
      });
      const data = await res.json();
      setResult(data);
    } catch { setResult({ _error: true }); }
    finally { setAnalyzing(false); }
  }

  async function saveSignal() {
    if (!result || !decisao) return;
    setSaving(true);
    try {
      const body = {
        evento: result.evento || jogo,
        competicao: result.competicao,
        mercado: mkt,
        score: result.score,
        criterios_ok: result.criterios_atendidos || [],
        criterios_no: result.criterios_nao_atendidos || [],
        insight: result.insight,
        resumo: result.resumo,
        decisao,
        odd: decisao === 'pegar' ? parseFloat(odd) || null : null,
        stake: decisao === 'pegar' ? parseFloat(stake) || null : null,
      };
      const res = await fetch('/api/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSaved(true);
        // Reset form
        setTimeout(() => {
          setJogo(''); setResult(null); setDecisao(null);
          setOdd(''); setStake(''); setSaved(false);
        }, 2000);
      }
    } catch {} finally { setSaving(false); }
  }

  async function updateResult(id, resultado) {
    setUpdatingId(id);
    try {
      await fetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id, resultado }),
      });
      await loadSignals();
    } catch {} finally { setUpdatingId(null); }
  }

  function logout() {
    document.cookie = 'st_token=; path=/; max-age=0';
    localStorage.clear();
    router.push('/login');
  }

  // ── COMPUTED STATS ──
  const pegados = signals.filter(s => s.decisao === 'pegar');
  const encerrados = pegados.filter(s => s.resultado);
  const greens = encerrados.filter(s => s.resultado === 'green');
  const reds = encerrados.filter(s => s.resultado === 'red');
  const lucroTotal = encerrados.reduce((acc, s) => acc + (s.lucro_real || 0), 0);
  const stakeTotal = encerrados.reduce((acc, s) => acc + (s.stake || 0), 0);
  const roi = stakeTotal > 0 ? (lucroTotal / stakeTotal) * 100 : 0;
  const winRate = encerrados.length > 0 ? (greens.length / encerrados.length) * 100 : 0;
  const lucroAcum = signals.reduce((acc, s, i) => {
    const prev = acc[i - 1] || 0;
    return [...acc, prev + (s.lucro_real || 0)];
  }, []);

  const mktInfo = MKTS.find(m => m.label === mkt) || MKTS[0];
  const lucPotencial = odd && stake ? ((parseFloat(stake) * parseFloat(odd)) - parseFloat(stake)) : null;

  if (!token) return <div style={{minHeight:'100vh',background:C.bg,display:'flex',alignItems:'center',justifyContent:'center'}}><div style={{color:C.muted,fontSize:'13px'}}>Carregando...</div></div>;

  return (
    <div style={{minHeight:'100vh',background:C.bg,fontFamily:'Inter,system-ui,sans-serif',color:C.text}}>

      {/* TOPBAR */}
      <div style={{height:'54px',background:'rgba(7,10,8,.97)',borderBottom:`1px solid ${C.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:'14px',position:'sticky',top:0,zIndex:100,backdropFilter:'blur(20px)'}}>
        {/* Logo mark */}
        <svg width="26" height="26" viewBox="0 0 44 44" fill="none" style={{flexShrink:0}}>
          <defs><linearGradient id="tlg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#00d084"/><stop offset="100%" stopColor="#00b4d8"/></linearGradient></defs>
          <rect x="1" y="1" width="42" height="42" rx="10" fill="url(#tlg)" fillOpacity=".12"/>
          <rect x="1" y="1" width="42" height="42" rx="10" stroke="url(#tlg)" strokeWidth="1.5" fill="none"/>
          <polyline points="10,31 18,21 26,26 34,13" stroke="#00d084" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          <polyline points="27,13 34,13 34,20" stroke="#00d084" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </svg>
        <span style={{fontSize:'14px',fontWeight:800,letterSpacing:'-.3px'}}>Scanner<span style={{color:C.g}}>Tips</span></span>

        <div style={{flex:1}}/>

        {/* AI status */}
        <div style={{display:'flex',alignItems:'center',gap:'5px',background:'rgba(0,208,132,.06)',border:`1px solid rgba(0,208,132,.15)`,borderRadius:'7px',padding:'5px 11px'}}>
          <div style={{width:'6px',height:'6px',borderRadius:'50%',background:C.g,animation:'pulse 2s infinite'}}/>
          <span style={{fontSize:'10px',fontWeight:700,color:C.g,letterSpacing:'.5px',textTransform:'uppercase'}}>IA Online</span>
        </div>

        {/* User + logout */}
        <div style={{display:'flex',alignItems:'center',gap:'8px',background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'7px',padding:'5px 11px'}}>
          <div style={{width:'26px',height:'26px',borderRadius:'50%',background:`linear-gradient(135deg,${C.g},#00b4d8)`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'11px',fontWeight:900,color:'#000'}}>
            {user?.email?.[0]?.toUpperCase() || 'U'}
          </div>
          <span style={{fontSize:'12px',fontWeight:600,maxWidth:'120px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{user?.email?.split('@')[0] || 'Usuário'}</span>
          <button onClick={logout} style={{background:'none',border:'none',color:C.muted,cursor:'pointer',padding:'2px',display:'flex',alignItems:'center'}} title="Sair">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </div>

      {/* TABS */}
      <div style={{background:C.bg2,borderBottom:`1px solid ${C.border}`,display:'flex',padding:'0 20px',gap:'2px'}}>
        {[
          {id:'analises', label:'Análises', icon:'M22 12h-4l-3 9L9 3l-3 9H2'},
          {id:'historico', label:'Histórico', icon:'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z'},
          {id:'desempenho', label:'Desempenho', icon:'M23 6 13.5 15.5 8.5 10.5 1 18 M17 6 23 6 23 12'},
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            display:'flex',alignItems:'center',gap:'7px',
            padding:'14px 16px',background:'none',border:'none',
            color: tab===t.id ? C.g : C.muted,
            fontWeight: tab===t.id ? 700 : 400,
            fontSize:'13px',cursor:'pointer',fontFamily:'inherit',
            borderBottom: tab===t.id ? `2px solid ${C.g}` : '2px solid transparent',
            transition:'all .16s',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points={t.icon}/>
            </svg>
            {t.label}
          </button>
        ))}
      </div>

      {/* CONTENT */}
      <div style={{maxWidth:'900px',margin:'0 auto',padding:'24px 20px'}}>

        {/* ════ ANÁLISES ════ */}
        {tab === 'analises' && (
          <div>
            <div style={{fontSize:'20px',fontWeight:900,letterSpacing:'-.4px',marginBottom:'4px'}}>Análise de Sinais</div>
            <div style={{fontSize:'13px',color:C.muted,marginBottom:'24px'}}>Selecione o mercado, informe o jogo e deixe a IA analisar</div>

            <div style={{display:'grid',gridTemplateColumns:'340px 1fr',gap:'20px',alignItems:'start'}}>

              {/* LEFT — Input */}
              <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>

                {/* Market selector */}
                <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'12px',padding:'16px'}}>
                  <div style={{fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'1.5px',textTransform:'uppercase',marginBottom:'11px'}}>Mercado</div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'7px'}}>
                    {MKTS.map(m => (
                      <button key={m.id} onClick={() => setMkt(m.label)} style={{
                        padding:'10px 12px',borderRadius:'8px',border:`1px solid ${mkt===m.label ? m.color : C.border}`,
                        background: mkt===m.label ? `${m.color}14` : C.bg4,
                        color: mkt===m.label ? m.color : C.muted,
                        fontSize:'12px',fontWeight: mkt===m.label ? 700 : 400,
                        cursor:'pointer',fontFamily:'inherit',textAlign:'left',transition:'all .16s',
                      }}>
                        <div style={{fontWeight:700,marginBottom:'2px'}}>{m.label}</div>
                        <div style={{fontSize:'10px',opacity:.7}}>min {m.min}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Jogo input */}
                <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'12px',padding:'16px'}}>
                  <label style={{display:'block',fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'1.5px',textTransform:'uppercase',marginBottom:'8px'}}>Jogo / Evento</label>
                  <textarea value={jogo} onChange={e=>setJogo(e.target.value)}
                    placeholder={"Ex: Arsenal vs Chelsea\nEx: Alcaraz vs Sinner — Roland Garros"}
                    rows={3} style={{width:'100%',background:C.bg4,border:`1px solid ${C.border}`,color:C.text,borderRadius:'8px',padding:'10px 12px',fontSize:'13px',fontFamily:'inherit',resize:'none',outline:'none',boxSizing:'border-box',lineHeight:'1.6'}}/>
                  <div style={{fontSize:'10px',color:'rgba(0,208,132,.5)',marginTop:'6px',display:'flex',alignItems:'center',gap:'5px'}}>
                    <div style={{width:'5px',height:'5px',borderRadius:'50%',background:C.g}}/>
                    API-Football + IA Anthropic
                  </div>
                </div>

                {/* Analyze button */}
                <button onClick={analyze} disabled={analyzing || !jogo.trim()} style={{
                  background: analyzing || !jogo.trim() ? C.muted3 : C.g,
                  color: analyzing || !jogo.trim() ? C.muted : '#000',
                  border:'none',borderRadius:'9px',padding:'13px',
                  fontSize:'14px',fontWeight:700,cursor: !jogo.trim() ? 'not-allowed' : 'pointer',
                  fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center',gap:'8px',
                  transition:'all .18s',
                }}>
                  {analyzing ? (
                    <>
                      <div style={{width:'14px',height:'14px',border:`2px solid rgba(0,0,0,.2)`,borderTopColor:'#000',borderRadius:'50%',animation:'spin .7s linear infinite'}}/>
                      Analisando...
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                      Analisar Sinal
                    </>
                  )}
                </button>
              </div>

              {/* RIGHT — Result */}
              <div>
                {!result && !analyzing && (
                  <div style={{background:C.bg3,border:`1px dashed rgba(0,208,132,.1)`,borderRadius:'12px',padding:'48px 24px',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:'14px'}}>
                    <div style={{width:'56px',height:'56px',borderRadius:'50%',background:'rgba(0,208,132,.07)',border:`1px solid rgba(0,208,132,.12)`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={C.g} strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    </div>
                    <div style={{fontSize:'15px',fontWeight:800,letterSpacing:'-.3px'}}>Pronto para analisar</div>
                    <div style={{fontSize:'13px',color:C.muted,maxWidth:'280px',lineHeight:1.7}}>Selecione o mercado, informe o jogo e clique em Analisar.</div>
                  </div>
                )}

                {analyzing && (
                  <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'12px',padding:'32px',display:'flex',flexDirection:'column',alignItems:'center',gap:'16px'}}>
                    <div style={{width:'48px',height:'48px',border:`3px solid rgba(0,208,132,.2)`,borderTopColor:C.g,borderRadius:'50%',animation:'spin .8s linear infinite'}}/>
                    <div style={{fontSize:'14px',color:C.g,fontWeight:600}}>IA analisando...</div>
                    <div style={{display:'flex',flexDirection:'column',gap:'8px',width:'100%',maxWidth:'240px'}}>
                      {['Conectando à API-Football...','Buscando dados dos times...','Analisando critérios...','Calculando score final...'].map((step,i) => (
                        <div key={i} style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'12px',color:C.muted}}>
                          <div style={{width:'5px',height:'5px',borderRadius:'50%',background:'rgba(0,208,132,.3)',animation:`pulse ${1+i*.3}s infinite`}}/>
                          {step}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {result && !analyzing && result._error && (
                  <div style={{
                    background:'rgba(239,68,68,.12)',
                    border:'1px solid rgba(239,68,68,.4)',
                    borderRadius:'12px',padding:'14px 16px',
                    display:'flex',alignItems:'flex-start',gap:'10px',
                  }}>
                    <span style={{fontSize:'18px',lineHeight:1}}>⚠️</span>
                    <div>
                      <div style={{fontSize:'13px',fontWeight:800,color:'#ef4444',letterSpacing:'.3px'}}>
                        FALHA NA ANÁLISE
                      </div>
                      <div style={{fontSize:'12px',color:C.muted,marginTop:'3px',lineHeight:1.5}}>
                        Não foi possível completar a análise (erro de conexão). Tente novamente.
                      </div>
                    </div>
                  </div>
                )}

                {result && !analyzing && !result._error && (
                  <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>

                    {result._demo && (
                      <div style={{
                        background:'rgba(239,68,68,.12)',
                        border:'1px solid rgba(239,68,68,.4)',
                        borderRadius:'12px',padding:'14px 16px',
                        display:'flex',alignItems:'flex-start',gap:'10px',
                      }}>
                        <span style={{fontSize:'18px',lineHeight:1}}>⚠️</span>
                        <div>
                          <div style={{fontSize:'13px',fontWeight:800,color:'#ef4444',letterSpacing:'.3px'}}>
                            ANÁLISE EM MODO DEMONSTRAÇÃO
                          </div>
                          <div style={{fontSize:'12px',color:C.muted,marginTop:'3px',lineHeight:1.5}}>
                            Este resultado é simulado e não usa IA real nem dados de jogos ao vivo. Não use para decisões de aposta.
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Score card */}
                    <div style={{
                      background: result.aprovado ? 'rgba(0,208,132,.06)' : 'rgba(239,68,68,.06)',
                      border:`1px solid ${result.aprovado ? 'rgba(0,208,132,.22)' : 'rgba(239,68,68,.22)'}`,
                      borderRadius:'12px',padding:'20px',position:'relative',overflow:'hidden',
                    }}>
                      <div style={{position:'absolute',top:0,left:0,right:0,height:'2px',background:`linear-gradient(90deg,${result.aprovado ? C.g : C.red},${result.aprovado ? '#00b4d8' : C.red})`}}/>
                      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'16px'}}>
                        <div>
                          <div style={{fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'2px',textTransform:'uppercase',marginBottom:'6px'}}>Veredito da IA</div>
                          <div style={{fontSize:'24px',fontWeight:900,color:result.aprovado ? C.g : C.red,letterSpacing:'-.5px',marginBottom:'4px'}}>
                            {result.aprovado ? '✓ APROVADO' : '✗ REPROVADO'}
                          </div>
                          <div style={{fontSize:'14px',color:C.text,fontWeight:600,marginBottom:'2px'}}>{result.evento || jogo}</div>
                          <div style={{fontSize:'12px',color:C.muted}}>{result.competicao}</div>
                          <div style={{fontSize:'12px',color:C.muted,marginTop:'8px',lineHeight:1.6}}>{result.insight}</div>
                        </div>
                        <div style={{textAlign:'center',flexShrink:0}}>
                          <div style={{
                            width:'80px',height:'80px',borderRadius:'50%',
                            border:`3px solid ${result.aprovado ? C.g : C.red}`,
                            display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',
                            background: result.aprovado ? 'rgba(0,208,132,.08)' : 'rgba(239,68,68,.08)',
                          }}>
                            <div style={{fontSize:'28px',fontWeight:900,color:result.aprovado ? C.g : C.red,lineHeight:1,letterSpacing:'-2px'}}>{result.score}</div>
                            <div style={{fontSize:'10px',color:C.muted2,fontWeight:700}}>/100</div>
                          </div>
                          <div style={{fontSize:'10px',color:C.muted2,marginTop:'5px'}}>min {result._minScore}</div>
                        </div>
                      </div>
                    </div>

                    {/* Criteria */}
                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px'}}>
                      <div style={{background:'rgba(0,208,132,.04)',border:'1px solid rgba(0,208,132,.12)',borderRadius:'10px',padding:'13px'}}>
                        <div style={{fontSize:'10px',fontWeight:700,color:C.g,letterSpacing:'1.5px',textTransform:'uppercase',marginBottom:'9px'}}>✓ Atendidos</div>
                        {(result.criterios_atendidos || []).length === 0
                          ? <div style={{fontSize:'12px',color:C.muted2}}>Nenhum</div>
                          : (result.criterios_atendidos || []).map((c,i) => (
                              <div key={i} style={{fontSize:'12px',color:C.muted,padding:'3px 0 3px 9px',borderLeft:`2px solid rgba(0,208,132,.3)`,marginBottom:'4px',lineHeight:1.5}}>{c}</div>
                            ))
                        }
                      </div>
                      <div style={{background:'rgba(239,68,68,.04)',border:'1px solid rgba(239,68,68,.12)',borderRadius:'10px',padding:'13px'}}>
                        <div style={{fontSize:'10px',fontWeight:700,color:C.red,letterSpacing:'1.5px',textTransform:'uppercase',marginBottom:'9px'}}>✗ Não atendidos</div>
                        {(result.criterios_nao_atendidos || []).length === 0
                          ? <div style={{fontSize:'12px',color:C.muted2}}>Nenhum ✓</div>
                          : (result.criterios_nao_atendidos || []).map((c,i) => (
                              <div key={i} style={{fontSize:'12px',color:C.muted,padding:'3px 0 3px 9px',borderLeft:`2px solid rgba(239,68,68,.3)`,marginBottom:'4px',lineHeight:1.5}}>{c}</div>
                            ))
                        }
                      </div>
                    </div>

                    {/* Resumo */}
                    <div style={{background:'rgba(0,208,132,.04)',border:`1px solid rgba(0,208,132,.1)`,borderRadius:'10px',padding:'13px 15px',position:'relative',overflow:'hidden'}}>
                      <div style={{position:'absolute',top:0,left:0,right:0,height:'1.5px',background:`linear-gradient(90deg,${C.g},#00b4d8,${C.purple})`,backgroundSize:'200%'}}/>
                      <div style={{fontSize:'10px',fontWeight:700,color:C.g,letterSpacing:'1.5px',textTransform:'uppercase',marginBottom:'6px'}}>Recomendação Operacional</div>
                      <div style={{fontSize:'13px',color:C.text,lineHeight:1.75}}>{result.resumo}</div>
                    </div>

                    {/* Decision */}
                    {!saved && (
                      <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'12px',padding:'18px'}}>
                        <div style={{fontSize:'13px',fontWeight:700,marginBottom:'13px'}}>Decisão</div>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'9px',marginBottom:'14px'}}>
                          <button onClick={()=>setDecisao('pegar')} style={{
                            padding:'12px',borderRadius:'9px',border:`2px solid ${decisao==='pegar' ? C.g : C.border}`,
                            background: decisao==='pegar' ? 'rgba(0,208,132,.1)' : C.bg4,
                            color: decisao==='pegar' ? C.g : C.muted,
                            fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all .18s',
                          }}>
                            ✓ Vou pegar
                          </button>
                          <button onClick={()=>setDecisao('passar')} style={{
                            padding:'12px',borderRadius:'9px',border:`2px solid ${decisao==='passar' ? C.red : C.border}`,
                            background: decisao==='passar' ? 'rgba(239,68,68,.08)' : C.bg4,
                            color: decisao==='passar' ? C.red : C.muted,
                            fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all .18s',
                          }}>
                            ✗ Passar
                          </button>
                        </div>

                        {decisao === 'pegar' && (
                          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'10px',marginBottom:'14px'}}>
                            <div>
                              <label style={{display:'block',fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'1.2px',textTransform:'uppercase',marginBottom:'6px'}}>Stake (R$)</label>
                              <input type="number" value={stake} onChange={e=>setStake(e.target.value)}
                                placeholder="Ex: 20" min="0.01" step="0.01"
                                style={{width:'100%',background:C.bg4,border:`1px solid ${C.border}`,color:C.text,borderRadius:'8px',padding:'10px 12px',fontSize:'14px',fontFamily:'inherit',outline:'none',boxSizing:'border-box'}}/>
                            </div>
                            <div>
                              <label style={{display:'block',fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'1.2px',textTransform:'uppercase',marginBottom:'6px'}}>Odd na Exchange</label>
                              <input type="number" value={odd} onChange={e=>setOdd(e.target.value)}
                                placeholder="Ex: 1.85" min="1.01" step="0.01"
                                style={{width:'100%',background:C.bg4,border:`1px solid ${C.border}`,color:C.text,borderRadius:'8px',padding:'10px 12px',fontSize:'14px',fontFamily:'inherit',outline:'none',boxSizing:'border-box'}}/>
                            </div>
                            {lucPotencial !== null && stake && odd && (
                              <div style={{gridColumn:'1/-1',background:'rgba(0,208,132,.06)',border:'1px solid rgba(0,208,132,.15)',borderRadius:'8px',padding:'11px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                                <span style={{fontSize:'12px',color:C.muted}}>Lucro potencial:</span>
                                <span style={{fontSize:'17px',fontWeight:800,color:C.g}}>+R${fmt(lucPotencial)}</span>
                              </div>
                            )}
                          </div>
                        )}

                        {decisao && (
                          <button onClick={saveSignal} disabled={saving || (decisao==='pegar' && (!stake || !odd))} style={{
                            width:'100%',background:saving ? C.muted3 : C.g,
                            color:saving ? C.muted : '#000',
                            border:'none',borderRadius:'9px',padding:'12px',
                            fontSize:'13px',fontWeight:700,cursor:saving?'not-allowed':'pointer',
                            fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center',gap:'7px',
                          }}>
                            {saving ? 'Salvando...' : 'Salvar no histórico →'}
                          </button>
                        )}
                      </div>
                    )}

                    {saved && (
                      <div style={{background:'rgba(0,208,132,.08)',border:'1px solid rgba(0,208,132,.25)',borderRadius:'10px',padding:'14px',textAlign:'center',fontSize:'14px',fontWeight:700,color:C.g}}>
                        ✓ Sinal salvo no histórico!
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ════ HISTÓRICO ════ */}
        {tab === 'historico' && (
          <div>
            <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'20px'}}>
              <div>
                <div style={{fontSize:'20px',fontWeight:900,letterSpacing:'-.4px',marginBottom:'4px'}}>Histórico</div>
                <div style={{fontSize:'13px',color:C.muted}}>Sinais que você decidiu pegar · Marque o resultado</div>
              </div>
              <button onClick={loadSignals} style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'8px',padding:'8px 14px',fontSize:'12px',color:C.muted,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:'6px'}}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-8.18"/></svg>
                Atualizar
              </button>
            </div>

            {loadingSignals ? (
              <div style={{textAlign:'center',padding:'48px',color:C.muted,fontSize:'13px'}}>Carregando...</div>
            ) : pegados.length === 0 ? (
              <div style={{background:C.bg3,border:`1px dashed rgba(0,208,132,.1)`,borderRadius:'12px',padding:'56px 32px',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:'14px'}}>
                <div style={{width:'56px',height:'56px',borderRadius:'50%',background:'rgba(0,208,132,.07)',border:`1px solid rgba(0,208,132,.12)`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={C.g} strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </div>
                <div style={{fontSize:'15px',fontWeight:800}}>Nenhum sinal ainda</div>
                <div style={{fontSize:'13px',color:C.muted,maxWidth:'280px',lineHeight:1.7}}>Analise um jogo e selecione "Vou pegar" para ele aparecer aqui.</div>
                <button onClick={()=>setTab('analises')} style={{background:C.g,color:'#000',border:'none',borderRadius:'8px',padding:'10px 22px',fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',marginTop:'4px'}}>
                  Ir para Análises →
                </button>
              </div>
            ) : (
              <div style={{display:'flex',flexDirection:'column',gap:'10px'}}>
                {pegados.map(s => {
                  const isGreen = s.resultado === 'green';
                  const isRed = s.resultado === 'red';
                  const borderColor = isGreen ? C.g : isRed ? C.red : C.border;
                  const lucBruto = s.stake && s.odd ? (s.stake * s.odd) - s.stake : null;
                  return (
                    <div key={s.id} style={{background:C.bg3,border:`1px solid ${borderColor}`,borderRadius:'12px',overflow:'hidden',transition:'border .18s'}}>
                      {/* Result strip */}
                      {s.resultado && <div style={{height:'2px',background: isGreen ? `linear-gradient(90deg,${C.g},${C.g2})` : `linear-gradient(90deg,${C.red},rgba(239,68,68,.4))`}}/>}
                      <div style={{padding:'14px 16px'}}>
                        <div style={{display:'flex',alignItems:'flex-start',gap:'12px'}}>
                          {/* Score */}
                          <div style={{width:'52px',height:'52px',borderRadius:'10px',background:C.bg4,border:`1px solid ${C.border}`,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                            <div style={{fontSize:'18px',fontWeight:900,color: s.score >= (s._minScore||82) ? C.g : C.orange,lineHeight:1,letterSpacing:'-1px'}}>{s.score}</div>
                            <div style={{fontSize:'9px',color:C.muted2,fontWeight:700,marginTop:'1px'}}>/100</div>
                          </div>
                          {/* Info */}
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{display:'flex',alignItems:'center',gap:'8px',flexWrap:'wrap',marginBottom:'4px'}}>
                              <span style={{fontSize:'14px',fontWeight:700,color:C.text}}>{s.evento}</span>
                              <span style={{background:'rgba(0,208,132,.1)',color:C.g,border:'1px solid rgba(0,208,132,.2)',borderRadius:'20px',padding:'2px 9px',fontSize:'10px',fontWeight:700}}>{s.mercado}</span>
                              {s.competicao && <span style={{background:'rgba(59,130,246,.1)',color:C.blue,border:'1px solid rgba(59,130,246,.2)',borderRadius:'20px',padding:'2px 9px',fontSize:'10px',fontWeight:700}}>{s.competicao}</span>}
                            </div>
                            <div style={{display:'flex',alignItems:'center',gap:'12px',fontSize:'12px',color:C.muted,flexWrap:'wrap'}}>
                              <span>Odd: <strong style={{color:C.text}}>{s.odd || '—'}</strong></span>
                              <span>Stake: <strong style={{color:C.text}}>R${fmt(s.stake)}</strong></span>
                              {lucBruto !== null && <span>Lucro pot.: <strong style={{color:C.g}}>+R${fmt(lucBruto)}</strong></span>}
                              <span style={{color:C.muted2}}>{new Date(s.analisado_em).toLocaleDateString('pt-BR')}</span>
                            </div>
                          </div>
                          {/* Result display or buttons */}
                          <div style={{flexShrink:0,textAlign:'right'}}>
                            {s.resultado ? (
                              <div style={{display:'flex',flexDirection:'column',gap:'4px',alignItems:'flex-end'}}>
                                <div style={{
                                  background: isGreen ? 'rgba(0,208,132,.12)' : 'rgba(239,68,68,.12)',
                                  border:`1px solid ${isGreen ? 'rgba(0,208,132,.25)' : 'rgba(239,68,68,.25)'}`,
                                  borderRadius:'20px',padding:'4px 13px',
                                  fontSize:'11px',fontWeight:800,
                                  color: isGreen ? C.g : C.red,
                                  letterSpacing:'.5px',
                                }}>
                                  {isGreen ? '✓ GREEN' : '✗ RED'}
                                </div>
                                {s.lucro_real !== null && (
                                  <div style={{fontSize:'16px',fontWeight:900,color: s.lucro_real >= 0 ? C.g : C.red,letterSpacing:'-.5px'}}>
                                    {s.lucro_real >= 0 ? '+' : ''}R${fmt(Math.abs(s.lucro_real))}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div style={{display:'flex',gap:'7px'}}>
                                <button onClick={()=>updateResult(s.id,'green')} disabled={updatingId===s.id} style={{background:'rgba(0,208,132,.1)',border:'1px solid rgba(0,208,132,.25)',borderRadius:'8px',padding:'7px 13px',color:C.g,fontSize:'12px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all .18s'}}>
                                  {updatingId===s.id ? '...' : '✓ Green'}
                                </button>
                                <button onClick={()=>updateResult(s.id,'red')} disabled={updatingId===s.id} style={{background:'rgba(239,68,68,.08)',border:'1px solid rgba(239,68,68,.2)',borderRadius:'8px',padding:'7px 13px',color:C.red,fontSize:'12px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all .18s'}}>
                                  {updatingId===s.id ? '...' : '✗ Red'}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ════ DESEMPENHO ════ */}
        {tab === 'desempenho' && (
          <div>
            <div style={{fontSize:'20px',fontWeight:900,letterSpacing:'-.4px',marginBottom:'4px'}}>Desempenho</div>
            <div style={{fontSize:'13px',color:C.muted,marginBottom:'24px'}}>ROI e resultados dos sinais que você pegou</div>

            {encerrados.length === 0 ? (
              <div style={{background:C.bg3,border:`1px dashed rgba(0,208,132,.1)`,borderRadius:'12px',padding:'56px 32px',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:'14px'}}>
                <div style={{width:'56px',height:'56px',borderRadius:'50%',background:'rgba(0,208,132,.07)',border:`1px solid rgba(0,208,132,.12)`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={C.g} strokeWidth="1.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                </div>
                <div style={{fontSize:'15px',fontWeight:800}}>Nenhum resultado ainda</div>
                <div style={{fontSize:'13px',color:C.muted,maxWidth:'300px',lineHeight:1.7}}>Marque seus sinais como Green ou Red no Histórico para ver seu desempenho real.</div>
                <button onClick={()=>setTab('historico')} style={{background:C.g,color:'#000',border:'none',borderRadius:'8px',padding:'10px 22px',fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',marginTop:'4px'}}>
                  Ir para Histórico →
                </button>
              </div>
            ) : (
              <>
                {/* KPIs */}
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'12px',marginBottom:'20px'}}>
                  {[
                    {label:'ROI',value:`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`,color: roi >= 0 ? C.g : C.red,sub:'sobre stake total'},
                    {label:'Lucro Total',value:`${lucroTotal >= 0 ? '+' : ''}R$${fmt(Math.abs(lucroTotal))}`,color: lucroTotal >= 0 ? C.g : C.red,sub:`${encerrados.length} sinais`},
                    {label:'Win Rate',value:`${winRate.toFixed(0)}%`,color: winRate >= 60 ? C.g : winRate >= 45 ? C.orange : C.red,sub:`${greens.length}G / ${reds.length}R`},
                    {label:'Sinais Pegados',value:pegados.length,color:C.text,sub:`${encerrados.length} encerrados`},
                  ].map((k,i) => (
                    <div key={i} style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'12px',padding:'16px'}}>
                      <div style={{fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'1.2px',textTransform:'uppercase',marginBottom:'8px'}}>{k.label}</div>
                      <div style={{fontSize:'22px',fontWeight:900,color:k.color,letterSpacing:'-.5px',lineHeight:1.1,marginBottom:'4px'}}>{k.value}</div>
                      <div style={{fontSize:'11px',color:C.muted}}>{k.sub}</div>
                    </div>
                  ))}
                </div>

                {/* Curva de lucro SVG */}
                {encerrados.length > 1 && (
                  <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'12px',padding:'18px',marginBottom:'16px',position:'relative',overflow:'hidden'}}>
                    <div style={{position:'absolute',top:0,left:0,right:0,height:'1.5px',background:`linear-gradient(90deg,${C.g},#00b4d8)`}}/>
                    <div style={{fontSize:'13px',fontWeight:700,marginBottom:'4px'}}>Curva de Lucro Acumulado</div>
                    <div style={{fontSize:'11px',color:C.muted,marginBottom:'16px'}}>Evolução sinal a sinal</div>
                    <svg viewBox={`0 0 600 140`} style={{width:'100%',height:'140px'}} preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={lucroTotal>=0?'#00d084':'#ef4444'} stopOpacity=".25"/>
                          <stop offset="100%" stopColor={lucroTotal>=0?'#00d084':'#ef4444'} stopOpacity="0"/>
                        </linearGradient>
                      </defs>
                      {(() => {
                        const pts = lucroAcum;
                        const n = pts.length;
                        const mn = Math.min(0,...pts);
                        const mx = Math.max(0,...pts);
                        const range = mx - mn || 1;
                        const W=600, H=120, pad=10;
                        const px = i => pad + (i/(n-1||1))*(W-pad*2);
                        const py = v => pad + (1-(v-mn)/range)*(H-pad*2);
                        const zero = py(0);
                        const pathD = pts.map((v,i) => `${i===0?'M':'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
                        const fillD = `${pathD} L${px(n-1)},${zero} L${px(0)},${zero} Z`;
                        const col = lucroTotal >= 0 ? C.g : C.red;
                        return (
                          <>
                            <line x1={pad} y1={zero} x2={W-pad} y2={zero} stroke="rgba(255,255,255,.06)" strokeWidth="1" strokeDasharray="4,4"/>
                            <path d={fillD} fill="url(#cg)"/>
                            <path d={pathD} fill="none" stroke={col} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                            {pts.map((v,i) => (
                              <circle key={i} cx={px(i)} cy={py(v)} r={i===n-1?4.5:3} fill={col} stroke="#0f1510" strokeWidth="2"/>
                            ))}
                          </>
                        );
                      })()}
                    </svg>
                  </div>
                )}

                {/* Per-signal breakdown */}
                <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'12px',overflow:'hidden'}}>
                  <div style={{padding:'13px 16px',borderBottom:`1px solid ${C.border}`,fontSize:'13px',fontWeight:700}}>Detalhamento por sinal</div>
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',minWidth:'480px'}}>
                      <thead>
                        <tr style={{background:C.bg4}}>
                          {['Evento','Mercado','Score','Odd','Stake','Lucro','ROI','Resultado'].map(h => (
                            <th key={h} style={{padding:'9px 14px',fontSize:'9.5px',fontWeight:700,letterSpacing:'1.2px',textTransform:'uppercase',color:C.muted2,textAlign:'left',whiteSpace:'nowrap'}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {encerrados.map((s,i) => {
                          const sRoi = s.stake ? ((s.lucro_real / s.stake) * 100) : 0;
                          const isG = s.resultado === 'green';
                          return (
                            <tr key={s.id} style={{borderBottom:`1px solid ${C.border}`}}>
                              <td style={{padding:'11px 14px',fontSize:'12.5px',color:C.text,fontWeight:600,whiteSpace:'nowrap'}}>{s.evento}</td>
                              <td style={{padding:'11px 14px'}}><span style={{background:'rgba(0,208,132,.1)',color:C.g,borderRadius:'20px',padding:'2px 8px',fontSize:'10px',fontWeight:700}}>{s.mercado}</span></td>
                              <td style={{padding:'11px 14px',fontSize:'15px',fontWeight:900,color:C.g}}>{s.score}</td>
                              <td style={{padding:'11px 14px',fontSize:'12px',color:C.muted}}>{s.odd}</td>
                              <td style={{padding:'11px 14px',fontSize:'12px',color:C.muted}}>R${fmt(s.stake)}</td>
                              <td style={{padding:'11px 14px',fontSize:'13px',fontWeight:700,color: s.lucro_real>=0 ? C.g : C.red}}>{s.lucro_real>=0?'+':''}R${fmt(Math.abs(s.lucro_real))}</td>
                              <td style={{padding:'11px 14px',fontSize:'12px',fontWeight:600,color: sRoi>=0 ? C.g : C.red}}>{sRoi>=0?'+':''}{sRoi.toFixed(1)}%</td>
                              <td style={{padding:'11px 14px'}}>
                                <span style={{background: isG?'rgba(0,208,132,.1)':'rgba(239,68,68,.1)',color:isG?C.g:C.red,border:`1px solid ${isG?'rgba(0,208,132,.2)':'rgba(239,68,68,.2)'}`,borderRadius:'20px',padding:'3px 10px',fontSize:'10px',fontWeight:800}}>
                                  {isG ? '✓ GREEN' : '✗ RED'}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(0,208,132,.4)}60%{box-shadow:0 0 0 6px rgba(0,208,132,0)}}
        input:focus,textarea:focus{border-color:rgba(0,208,132,.35)!important;box-shadow:0 0 0 3px rgba(0,208,132,.07)}
        button:hover{opacity:.88}
        @media(max-width:700px){
          .grid-2col{grid-template-columns:1fr!important}
        }
      `}</style>
    </div>
  );
}
