'use client';
export const dynamic = 'force-dynamic';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { authFetch, getStoredToken, getStoredUser, clearSession } from '@/lib/clientSession';
import { C, FONT_DISPLAY, FONT_BODY, FONT_MONO } from '@/lib/theme';

const MKTS = [
  { id:'lay2x2',   label:'Lay 2x2',      min:82 },
  { id:'layzebra', label:'Lay Zebra',     min:85 },
  { id:'mais15',   label:'+1.5 Gols',    min:83 },
  { id:'mais05',   label:'+0.5 Gols',    min:88 },
  { id:'tenis',    label:'Tênis',         min:84 },
  { id:'menos25',  label:'-2.5 Gols 1T', min:86 },
];

const NAV = [
  { id:'analises',   label:'Análises',    icon:'M22 12h-4l-3 9L9 3l-3 9H2' },
  { id:'historico',  label:'Histórico',   icon:'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z' },
  { id:'desempenho', label:'Desempenho',  icon:'M23 6 13.5 15.5 8.5 10.5 1 18 M17 6 23 6 23 12' },
];

function fmt(v) { return v?.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) ?? '—'; }

// ── Elemento de assinatura: o anel de confiança ──
// Reaparece na marca (login/cadastro) e aqui no veredito — um fio visual que
// conecta a identidade ao dado em si, em vez de ser só decoração.
function ScoreRing({ score, color, size = 108 }) {
  const r = 42, cx = 52, cy = 52;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score ?? 0)) / 100;
  const dash = circ * pct;
  return (
    <svg width={size} height={size} viewBox="0 0 104 104">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.border} strokeWidth="6"/>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`} transform={`rotate(-90 ${cx} ${cy})`}
        style={{transition:'stroke-dasharray .7s cubic-bezier(.4,0,.2,1)', filter:`drop-shadow(0 0 7px ${color}90)`}}/>
      <text x={cx} y={cy - 3} textAnchor="middle" fill={color} fontWeight="800" fontSize="22"
        style={{fontFamily:FONT_MONO}}>{score ?? '—'}</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fill={C.muted2} fontWeight="700" fontSize="9"
        style={{fontFamily:FONT_MONO, letterSpacing:'1px'}}>/100</text>
    </svg>
  );
}

export default function App() {
  const router = useRouter();
  const [tab, setTab] = useState('analises');
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);

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
    const t = getStoredToken();
    if (!t) { router.push('/login'); return; }
    setUser(getStoredUser());
    setAuthReady(true);
  }, [router]);

  useEffect(() => {
    if (authReady && tab === 'historico') loadSignals();
    if (authReady && tab === 'desempenho') loadSignals();
  }, [tab, authReady]);

  function goToLoginExpired() {
    clearSession();
    router.push('/login?msg=sessao-expirada');
  }

  const loadSignals = useCallback(async () => {
    setLoadingSignals(true);
    try {
      const { res, sessionExpired } = await authFetch('/api/signals');
      if (sessionExpired) { goToLoginExpired(); return; }
      const data = await res.json();
      if (data.signals) setSignals(data.signals);
    } catch {} finally { setLoadingSignals(false); }
  }, []);

  async function analyze() {
    if (!jogo.trim()) return;
    setAnalyzing(true); setResult(null); setDecisao(null); setSaved(false);
    try {
      const { res, sessionExpired } = await authFetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jogo, mercado: mkt }),
      });
      if (sessionExpired) { goToLoginExpired(); return; }
      const data = await res.json();
      if (!res.ok) { setResult({ _error: true, _msg: data?.error || null }); return; }
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
      const { res, sessionExpired } = await authFetch('/api/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (sessionExpired) { goToLoginExpired(); return; }
      if (res.ok) {
        setSaved(true);
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
      const { sessionExpired } = await authFetch('/api/signals', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, resultado }),
      });
      if (sessionExpired) { goToLoginExpired(); return; }
      await loadSignals();
    } catch {} finally { setUpdatingId(null); }
  }

  function logout() {
    clearSession();
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

  if (!authReady) return (
    <div style={{minHeight:'100vh',background:C.bg,display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div style={{color:C.muted,fontSize:'13px',fontFamily:FONT_BODY}}>Carregando...</div>
    </div>
  );

  return (
    <div style={{minHeight:'100vh',background:C.bg,fontFamily:FONT_BODY,color:C.text}}>

      {/* TOPBAR */}
      <div style={{height:'56px',background:'rgba(10,10,10,.97)',borderBottom:`1px solid ${C.border}`,display:'flex',alignItems:'center',padding:'0 20px',gap:'14px',position:'sticky',top:0,zIndex:100,backdropFilter:'blur(20px)'}}>
        <svg width="26" height="26" viewBox="0 0 44 44" fill="none" style={{flexShrink:0}}>
          <rect x="1" y="1" width="42" height="42" rx="10" fill={C.orangeDim} stroke={C.orange} strokeWidth="1.5"/>
          <circle cx="22" cy="22" r="11" fill="none" stroke={C.orange} strokeWidth="2.2" strokeDasharray="52 17" strokeLinecap="round" transform="rotate(-90 22 22)"/>
          <circle cx="22" cy="11" r="2" fill={C.orange}/>
        </svg>
        <span style={{fontSize:'14px',fontWeight:700,letterSpacing:'-.2px',fontFamily:FONT_DISPLAY}}>ORIS<span style={{color:C.orange}}> CLUB</span></span>

        <div style={{flex:1}}/>

        <div style={{display:'flex',alignItems:'center',gap:'5px',background:C.orangeDim,border:`1px solid ${C.orangeBorder}`,borderRadius:'7px',padding:'5px 11px'}}>
          <div style={{width:'6px',height:'6px',borderRadius:'50%',background:C.orange,animation:'pulseOrange 2s infinite'}}/>
          <span style={{fontSize:'10px',fontWeight:700,color:C.orangeGlow,letterSpacing:'.5px',textTransform:'uppercase'}}>IA Online</span>
        </div>

        <div style={{display:'flex',alignItems:'center',gap:'8px',background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'7px',padding:'5px 11px'}}>
          <div style={{width:'26px',height:'26px',borderRadius:'50%',background:C.orange,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'11px',fontWeight:800,color:'#0A0A0A'}}>
            {user?.email?.[0]?.toUpperCase() || 'U'}
          </div>
          <span style={{fontSize:'12px',fontWeight:600,maxWidth:'120px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{user?.email?.split('@')[0] || 'Usuário'}</span>
          <button onClick={logout} style={{background:'none',border:'none',color:C.muted,cursor:'pointer',padding:'2px',display:'flex',alignItems:'center'}} title="Sair">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </div>

      <div className="app-shell" style={{display:'flex'}}>

        {/* NAV RAIL */}
        <nav className="nav-rail" style={{display:'flex',flexDirection:'column',width:'76px',background:C.bg2,borderRight:`1px solid ${C.border}`,padding:'14px 0',gap:'4px',position:'sticky',top:'56px',height:'calc(100vh - 56px)',flexShrink:0}}>
          {NAV.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display:'flex',flexDirection:'column',alignItems:'center',gap:'5px',
              padding:'12px 4px',margin:'0 8px',borderRadius:'9px',
              background: tab===t.id ? C.orangeDim : 'transparent',
              border:'none',
              color: tab===t.id ? C.orange : C.muted,
              fontSize:'10px',fontWeight: tab===t.id ? 700 : 500,
              cursor:'pointer',fontFamily:'inherit',transition:'all .16s',
            }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points={t.icon}/>
              </svg>
              {t.label}
            </button>
          ))}
        </nav>

        {/* MAIN */}
        <main style={{flex:1,minWidth:0,maxWidth:'880px',margin:'0 auto',padding:'28px 22px',width:'100%'}}>

          {/* ════ ANÁLISES ════ */}
          {tab === 'analises' && (
            <div>
              <div style={{fontSize:'10px',fontWeight:700,color:C.orange,letterSpacing:'2px',textTransform:'uppercase',marginBottom:'6px'}}>Painel de Análise</div>
              <div style={{fontSize:'21px',fontWeight:800,letterSpacing:'-.3px',marginBottom:'4px',fontFamily:FONT_DISPLAY}}>Análise de Sinais</div>
              <div style={{fontSize:'13px',color:C.muted,marginBottom:'20px'}}>Selecione o mercado, informe o jogo e deixe a IA analisar</div>

              {/* COMMAND BAR */}
              <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'14px',padding:'20px',position:'relative',overflow:'hidden'}}>
                <div style={{position:'absolute',top:0,left:0,right:0,height:'2px',background:`linear-gradient(90deg,${C.orange},${C.orangeGlow})`}}/>

                <div style={{fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'1.5px',textTransform:'uppercase',marginBottom:'11px'}}>Mercado</div>
                <div style={{display:'flex',flexWrap:'wrap',gap:'8px',marginBottom:'18px'}}>
                  {MKTS.map(m => (
                    <button key={m.id} onClick={() => setMkt(m.label)} style={{
                      padding:'9px 14px',borderRadius:'8px',
                      border:`1px solid ${mkt===m.label ? C.orange : C.border}`,
                      background: mkt===m.label ? C.orangeDim : C.bg4,
                      color: mkt===m.label ? C.orangeGlow : C.muted,
                      fontSize:'12px',fontWeight: mkt===m.label ? 700 : 500,
                      cursor:'pointer',fontFamily:'inherit',whiteSpace:'nowrap',transition:'all .16s',
                    }}>
                      {m.label} <span style={{opacity:.65,fontFamily:FONT_MONO,fontSize:'10px',marginLeft:'4px'}}>min {m.min}</span>
                    </button>
                  ))}
                </div>

                <div style={{height:'1px',background:C.border,margin:'0 0 18px'}}/>

                <label style={{display:'block',fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'1.5px',textTransform:'uppercase',marginBottom:'8px'}}>Jogo / Evento</label>
                <textarea value={jogo} onChange={e=>setJogo(e.target.value)}
                  placeholder={"Ex: Arsenal vs Chelsea\nEx: Alcaraz vs Sinner — Roland Garros"}
                  rows={3} style={{width:'100%',background:C.bg4,border:`1px solid ${C.border}`,color:C.text,borderRadius:'8px',padding:'10px 12px',fontSize:'13px',fontFamily:'inherit',resize:'none',outline:'none',boxSizing:'border-box',lineHeight:'1.6'}}/>
                <div style={{fontSize:'10px',color:C.muted2,marginTop:'8px',marginBottom:'18px',display:'flex',alignItems:'center',gap:'5px'}}>
                  <div style={{width:'5px',height:'5px',borderRadius:'50%',background:C.orange}}/>
                  API-Football + IA Anthropic
                </div>

                <button onClick={analyze} disabled={analyzing || !jogo.trim()} style={{
                  width:'100%',
                  background: analyzing || !jogo.trim() ? C.muted3 : C.orange,
                  color: analyzing || !jogo.trim() ? C.muted : '#0A0A0A',
                  border:'none',borderRadius:'9px',padding:'13px',
                  fontSize:'14px',fontWeight:700,cursor: !jogo.trim() ? 'not-allowed' : 'pointer',
                  fontFamily:'inherit',display:'flex',alignItems:'center',justifyContent:'center',gap:'8px',
                  transition:'all .18s',
                }}>
                  {analyzing ? (
                    <>
                      <div style={{width:'14px',height:'14px',border:`2px solid rgba(0,0,0,.2)`,borderTopColor:'#0A0A0A',borderRadius:'50%',animation:'spin .7s linear infinite'}}/>
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

              {/* RESULT PANEL */}
              <div style={{marginTop:'16px'}}>
                {!result && !analyzing && (
                  <div style={{background:C.bg3,border:`1px dashed ${C.border}`,borderRadius:'14px',padding:'40px 24px',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:'14px'}}>
                    <div style={{width:'52px',height:'52px',borderRadius:'50%',background:C.orangeDim,border:`1px solid ${C.orangeBorder}`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={C.orange} strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    </div>
                    <div style={{fontSize:'15px',fontWeight:700,letterSpacing:'-.2px',fontFamily:FONT_DISPLAY}}>Pronto para analisar</div>
                    <div style={{fontSize:'13px',color:C.muted,maxWidth:'280px',lineHeight:1.7}}>Selecione o mercado, informe o jogo e clique em Analisar.</div>
                  </div>
                )}

                {analyzing && (
                  <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'14px',padding:'32px',display:'flex',flexDirection:'column',alignItems:'center',gap:'16px'}}>
                    <div style={{width:'46px',height:'46px',border:`3px solid ${C.orangeDim}`,borderTopColor:C.orange,borderRadius:'50%',animation:'spin .8s linear infinite'}}/>
                    <div style={{fontSize:'14px',color:C.orangeGlow,fontWeight:600}}>IA analisando...</div>
                    <div style={{display:'flex',flexDirection:'column',gap:'8px',width:'100%',maxWidth:'240px'}}>
                      {['Conectando à API-Football...','Buscando dados dos times...','Analisando critérios...','Calculando score final...'].map((step,i) => (
                        <div key={i} style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'12px',color:C.muted}}>
                          <div style={{width:'5px',height:'5px',borderRadius:'50%',background:C.orange,animation:`pulseOrange ${1+i*.3}s infinite`}}/>
                          {step}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {result && !analyzing && result._error && (
                  <div style={{background:C.redDim,border:`1px solid rgba(255,77,77,.35)`,borderRadius:'14px',padding:'14px 16px',display:'flex',alignItems:'flex-start',gap:'10px'}}>
                    <span style={{fontSize:'18px',lineHeight:1}}>⚠️</span>
                    <div>
                      <div style={{fontSize:'13px',fontWeight:800,color:C.red,letterSpacing:'.3px'}}>FALHA NA ANÁLISE</div>
                      <div style={{fontSize:'12px',color:C.muted,marginTop:'3px',lineHeight:1.5}}>
                        {result._msg || 'Não foi possível completar a análise (erro de conexão). Tente novamente.'}
                      </div>
                    </div>
                  </div>
                )}

                {result && !analyzing && !result._error && (
                  <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>

                    {result._demo && (
                      <div style={{background:C.redDim,border:`1px solid rgba(255,77,77,.35)`,borderRadius:'14px',padding:'14px 16px',display:'flex',alignItems:'flex-start',gap:'10px'}}>
                        <span style={{fontSize:'18px',lineHeight:1}}>⚠️</span>
                        <div>
                          <div style={{fontSize:'13px',fontWeight:800,color:C.red,letterSpacing:'.3px'}}>ANÁLISE EM MODO DEMONSTRAÇÃO</div>
                          <div style={{fontSize:'12px',color:C.muted,marginTop:'3px',lineHeight:1.5}}>
                            Este resultado é simulado e não usa IA real nem dados de jogos ao vivo. Não use para decisões de aposta.
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Veredito — anel de confiança */}
                    {(() => {
                      const verdictColor = result.aprovado ? C.green : C.red;
                      return (
                        <div className="verdict-card" style={{
                          background: result.aprovado ? C.greenDim : C.redDim,
                          border:`1px solid ${result.aprovado ? 'rgba(0,208,132,.25)' : 'rgba(255,77,77,.25)'}`,
                          borderRadius:'14px',padding:'22px',position:'relative',overflow:'hidden',
                          display:'flex',alignItems:'center',gap:'22px',
                        }}>
                          <div style={{position:'absolute',top:0,left:0,right:0,height:'2px',background:verdictColor}}/>
                          <ScoreRing score={result.score} color={verdictColor}/>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'2px',textTransform:'uppercase',marginBottom:'6px'}}>Veredito da IA · min {result._minScore}</div>
                            <div style={{fontSize:'20px',fontWeight:800,color:verdictColor,letterSpacing:'-.4px',marginBottom:'5px',fontFamily:FONT_DISPLAY}}>
                              {result.aprovado ? '✓ APROVADO' : '✗ REPROVADO'}
                            </div>
                            <div style={{fontSize:'14px',color:C.text,fontWeight:600,marginBottom:'2px'}}>{result.evento || jogo}</div>
                            <div style={{fontSize:'12px',color:C.muted}}>{result.competicao}</div>
                            <div style={{fontSize:'12px',color:C.muted,marginTop:'8px',lineHeight:1.6}}>{result.insight}</div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Critérios — duas colunas com linha fina divisória */}
                    <div className="criteria-split" style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'14px',display:'flex',overflow:'hidden'}}>
                      <div style={{flex:1,padding:'15px',minWidth:0}}>
                        <div style={{fontSize:'10px',fontWeight:700,color:C.green,letterSpacing:'1.5px',textTransform:'uppercase',marginBottom:'10px'}}>✓ Atendidos</div>
                        {(result.criterios_atendidos || []).length === 0
                          ? <div style={{fontSize:'12px',color:C.muted2}}>Nenhum</div>
                          : (result.criterios_atendidos || []).map((c,i) => (
                              <div key={i} style={{fontSize:'12px',color:C.muted,padding:'3px 0 3px 9px',borderLeft:`2px solid rgba(0,208,132,.35)`,marginBottom:'4px',lineHeight:1.5}}>{c}</div>
                            ))
                        }
                      </div>
                      <div style={{width:'1px',background:C.border,flexShrink:0}}/>
                      <div style={{flex:1,padding:'15px',minWidth:0}}>
                        <div style={{fontSize:'10px',fontWeight:700,color:C.red,letterSpacing:'1.5px',textTransform:'uppercase',marginBottom:'10px'}}>✗ Não atendidos</div>
                        {(result.criterios_nao_atendidos || []).length === 0
                          ? <div style={{fontSize:'12px',color:C.muted2}}>Nenhum ✓</div>
                          : (result.criterios_nao_atendidos || []).map((c,i) => (
                              <div key={i} style={{fontSize:'12px',color:C.muted,padding:'3px 0 3px 9px',borderLeft:`2px solid rgba(255,77,77,.35)`,marginBottom:'4px',lineHeight:1.5}}>{c}</div>
                            ))
                        }
                      </div>
                    </div>

                    {/* Resumo */}
                    <div style={{background:C.orangeDim,border:`1px solid ${C.orangeBorder}`,borderRadius:'12px',padding:'14px 16px',position:'relative',overflow:'hidden'}}>
                      <div style={{position:'absolute',top:0,left:0,right:0,height:'1.5px',background:`linear-gradient(90deg,${C.orange},${C.orangeGlow})`}}/>
                      <div style={{fontSize:'10px',fontWeight:700,color:C.orange,letterSpacing:'1.5px',textTransform:'uppercase',marginBottom:'6px'}}>Recomendação Operacional</div>
                      <div style={{fontSize:'13px',color:C.text,lineHeight:1.75}}>{result.resumo}</div>
                    </div>

                    {/* Decision */}
                    {!saved && (
                      <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'14px',padding:'18px'}}>
                        <div style={{fontSize:'13px',fontWeight:700,marginBottom:'13px'}}>Decisão</div>
                        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'9px',marginBottom:'14px'}}>
                          <button onClick={()=>setDecisao('pegar')} style={{
                            padding:'12px',borderRadius:'9px',border:`2px solid ${decisao==='pegar' ? C.green : C.border}`,
                            background: decisao==='pegar' ? C.greenDim : C.bg4,
                            color: decisao==='pegar' ? C.green : C.muted,
                            fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all .18s',
                          }}>✓ Vou pegar</button>
                          <button onClick={()=>setDecisao('passar')} style={{
                            padding:'12px',borderRadius:'9px',border:`2px solid ${decisao==='passar' ? C.red : C.border}`,
                            background: decisao==='passar' ? C.redDim : C.bg4,
                            color: decisao==='passar' ? C.red : C.muted,
                            fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all .18s',
                          }}>✗ Passar</button>
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
                              <div style={{gridColumn:'1/-1',background:C.greenDim,border:'1px solid rgba(0,208,132,.2)',borderRadius:'8px',padding:'11px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                                <span style={{fontSize:'12px',color:C.muted}}>Lucro potencial:</span>
                                <span style={{fontSize:'17px',fontWeight:800,color:C.green,fontFamily:FONT_MONO}}>+R${fmt(lucPotencial)}</span>
                              </div>
                            )}
                          </div>
                        )}

                        {decisao && (
                          <button onClick={saveSignal} disabled={saving || (decisao==='pegar' && (!stake || !odd))} style={{
                            width:'100%',background:saving ? C.muted3 : C.orange,
                            color:saving ? C.muted : '#0A0A0A',
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
                      <div style={{background:C.greenDim,border:'1px solid rgba(0,208,132,.3)',borderRadius:'10px',padding:'14px',textAlign:'center',fontSize:'14px',fontWeight:700,color:C.green}}>
                        ✓ Sinal salvo no histórico!
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ════ HISTÓRICO ════ */}
          {tab === 'historico' && (
            <div>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'20px',flexWrap:'wrap',gap:'10px'}}>
                <div>
                  <div style={{fontSize:'21px',fontWeight:800,letterSpacing:'-.3px',marginBottom:'4px',fontFamily:FONT_DISPLAY}}>Histórico</div>
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
                <div style={{background:C.bg3,border:`1px dashed ${C.border}`,borderRadius:'14px',padding:'56px 32px',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:'14px'}}>
                  <div style={{width:'56px',height:'56px',borderRadius:'50%',background:C.orangeDim,border:`1px solid ${C.orangeBorder}`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={C.orange} strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  </div>
                  <div style={{fontSize:'15px',fontWeight:700,fontFamily:FONT_DISPLAY}}>Nenhum sinal ainda</div>
                  <div style={{fontSize:'13px',color:C.muted,maxWidth:'280px',lineHeight:1.7}}>Analise um jogo e selecione "Vou pegar" para ele aparecer aqui.</div>
                  <button onClick={()=>setTab('analises')} style={{background:C.orange,color:'#0A0A0A',border:'none',borderRadius:'8px',padding:'10px 22px',fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',marginTop:'4px'}}>
                    Ir para Análises →
                  </button>
                </div>
              ) : (
                <div style={{display:'flex',flexDirection:'column',gap:'10px'}}>
                  {pegados.map(s => {
                    const isGreen = s.resultado === 'green';
                    const isRed = s.resultado === 'red';
                    const borderColor = isGreen ? C.green : isRed ? C.red : C.border;
                    const scoreColor = s.score >= (s._minScore || 82) ? C.green : C.red;
                    const lucBruto = s.stake && s.odd ? (s.stake * s.odd) - s.stake : null;
                    return (
                      <div key={s.id} style={{background:C.bg3,border:`1px solid ${borderColor}`,borderRadius:'14px',overflow:'hidden',transition:'border .18s'}}>
                        {s.resultado && <div style={{height:'2px',background: isGreen ? C.green : C.red}}/>}
                        <div style={{padding:'14px 16px'}}>
                          <div style={{display:'flex',alignItems:'flex-start',gap:'12px',flexWrap:'wrap'}}>
                            <div style={{width:'52px',height:'52px',borderRadius:'10px',background:C.bg4,border:`1px solid ${C.border}`,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                              <div style={{fontSize:'18px',fontWeight:800,color:scoreColor,lineHeight:1,fontFamily:FONT_MONO}}>{s.score}</div>
                              <div style={{fontSize:'9px',color:C.muted2,fontWeight:700,marginTop:'1px',fontFamily:FONT_MONO}}>/100</div>
                            </div>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{display:'flex',alignItems:'center',gap:'8px',flexWrap:'wrap',marginBottom:'4px'}}>
                                <span style={{fontSize:'14px',fontWeight:700,color:C.text}}>{s.evento}</span>
                                <span style={{background:C.orangeDim,color:C.orangeGlow,border:`1px solid ${C.orangeBorder}`,borderRadius:'20px',padding:'2px 9px',fontSize:'10px',fontWeight:700}}>{s.mercado}</span>
                                {s.competicao && <span style={{background:C.bg4,color:C.muted,border:`1px solid ${C.border}`,borderRadius:'20px',padding:'2px 9px',fontSize:'10px',fontWeight:700}}>{s.competicao}</span>}
                              </div>
                              <div style={{display:'flex',alignItems:'center',gap:'12px',fontSize:'12px',color:C.muted,flexWrap:'wrap'}}>
                                <span>Odd: <strong style={{color:C.text}}>{s.odd || '—'}</strong></span>
                                <span>Stake: <strong style={{color:C.text}}>R${fmt(s.stake)}</strong></span>
                                {lucBruto !== null && <span>Lucro pot.: <strong style={{color:C.green}}>+R${fmt(lucBruto)}</strong></span>}
                                <span style={{color:C.muted2}}>{new Date(s.analisado_em).toLocaleDateString('pt-BR')}</span>
                              </div>
                            </div>
                            <div style={{flexShrink:0,textAlign:'right'}}>
                              {s.resultado ? (
                                <div style={{display:'flex',flexDirection:'column',gap:'4px',alignItems:'flex-end'}}>
                                  <div style={{background: isGreen ? C.greenDim : C.redDim,border:`1px solid ${isGreen ? 'rgba(0,208,132,.3)' : 'rgba(255,77,77,.3)'}`,borderRadius:'20px',padding:'4px 13px',fontSize:'11px',fontWeight:800,color: isGreen ? C.green : C.red,letterSpacing:'.5px'}}>
                                    {isGreen ? '✓ GREEN' : '✗ RED'}
                                  </div>
                                  {s.lucro_real !== null && (
                                    <div style={{fontSize:'16px',fontWeight:800,color: s.lucro_real >= 0 ? C.green : C.red,fontFamily:FONT_MONO}}>
                                      {s.lucro_real >= 0 ? '+' : ''}R${fmt(Math.abs(s.lucro_real))}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div style={{display:'flex',gap:'7px'}}>
                                  <button onClick={()=>updateResult(s.id,'green')} disabled={updatingId===s.id} style={{background:C.greenDim,border:'1px solid rgba(0,208,132,.3)',borderRadius:'8px',padding:'7px 13px',color:C.green,fontSize:'12px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all .18s'}}>
                                    {updatingId===s.id ? '...' : '✓ Green'}
                                  </button>
                                  <button onClick={()=>updateResult(s.id,'red')} disabled={updatingId===s.id} style={{background:C.redDim,border:'1px solid rgba(255,77,77,.25)',borderRadius:'8px',padding:'7px 13px',color:C.red,fontSize:'12px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all .18s'}}>
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
              <div style={{fontSize:'21px',fontWeight:800,letterSpacing:'-.3px',marginBottom:'4px',fontFamily:FONT_DISPLAY}}>Desempenho</div>
              <div style={{fontSize:'13px',color:C.muted,marginBottom:'24px'}}>ROI e resultados dos sinais que você pegou</div>

              {encerrados.length === 0 ? (
                <div style={{background:C.bg3,border:`1px dashed ${C.border}`,borderRadius:'14px',padding:'56px 32px',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:'14px'}}>
                  <div style={{width:'56px',height:'56px',borderRadius:'50%',background:C.orangeDim,border:`1px solid ${C.orangeBorder}`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={C.orange} strokeWidth="1.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                  </div>
                  <div style={{fontSize:'15px',fontWeight:700,fontFamily:FONT_DISPLAY}}>Nenhum resultado ainda</div>
                  <div style={{fontSize:'13px',color:C.muted,maxWidth:'300px',lineHeight:1.7}}>Marque seus sinais como Green ou Red no Histórico para ver seu desempenho real.</div>
                  <button onClick={()=>setTab('historico')} style={{background:C.orange,color:'#0A0A0A',border:'none',borderRadius:'8px',padding:'10px 22px',fontSize:'13px',fontWeight:700,cursor:'pointer',fontFamily:'inherit',marginTop:'4px'}}>
                    Ir para Histórico →
                  </button>
                </div>
              ) : (
                <>
                  <div className="kpi-grid" style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'12px',marginBottom:'20px'}}>
                    {[
                      {label:'ROI',value:`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`,color: roi >= 0 ? C.green : C.red,sub:'sobre stake total'},
                      {label:'Lucro Total',value:`${lucroTotal >= 0 ? '+' : ''}R$${fmt(Math.abs(lucroTotal))}`,color: lucroTotal >= 0 ? C.green : C.red,sub:`${encerrados.length} sinais`},
                      {label:'Win Rate',value:`${winRate.toFixed(0)}%`,color: winRate >= 50 ? C.green : C.red,sub:`${greens.length}G / ${reds.length}R`},
                      {label:'Sinais Pegados',value:pegados.length,color:C.text,sub:`${encerrados.length} encerrados`},
                    ].map((k,i) => (
                      <div key={i} style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'12px',padding:'16px'}}>
                        <div style={{fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'1.2px',textTransform:'uppercase',marginBottom:'8px'}}>{k.label}</div>
                        <div style={{fontSize:'21px',fontWeight:800,color:k.color,letterSpacing:'-.4px',lineHeight:1.1,marginBottom:'4px',fontFamily:FONT_MONO}}>{k.value}</div>
                        <div style={{fontSize:'11px',color:C.muted}}>{k.sub}</div>
                      </div>
                    ))}
                  </div>

                  {encerrados.length > 1 && (
                    <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'14px',padding:'18px',marginBottom:'16px',position:'relative',overflow:'hidden'}}>
                      <div style={{position:'absolute',top:0,left:0,right:0,height:'1.5px',background: lucroTotal>=0 ? C.green : C.red}}/>
                      <div style={{fontSize:'13px',fontWeight:700,marginBottom:'4px'}}>Curva de Lucro Acumulado</div>
                      <div style={{fontSize:'11px',color:C.muted,marginBottom:'16px'}}>Evolução sinal a sinal</div>
                      <svg viewBox={`0 0 600 140`} style={{width:'100%',height:'140px'}} preserveAspectRatio="none">
                        <defs>
                          <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={lucroTotal>=0?C.green:C.red} stopOpacity=".25"/>
                            <stop offset="100%" stopColor={lucroTotal>=0?C.green:C.red} stopOpacity="0"/>
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
                          const col = lucroTotal >= 0 ? C.green : C.red;
                          return (
                            <>
                              <line x1={pad} y1={zero} x2={W-pad} y2={zero} stroke="rgba(255,255,255,.06)" strokeWidth="1" strokeDasharray="4,4"/>
                              <path d={fillD} fill="url(#cg)"/>
                              <path d={pathD} fill="none" stroke={col} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                              {pts.map((v,i) => (
                                <circle key={i} cx={px(i)} cy={py(v)} r={i===n-1?4.5:3} fill={col} stroke={C.bg3} strokeWidth="2"/>
                              ))}
                            </>
                          );
                        })()}
                      </svg>
                    </div>
                  )}

                  <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'14px',overflow:'hidden'}}>
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
                                <td style={{padding:'11px 14px'}}><span style={{background:C.orangeDim,color:C.orangeGlow,borderRadius:'20px',padding:'2px 8px',fontSize:'10px',fontWeight:700}}>{s.mercado}</span></td>
                                <td style={{padding:'11px 14px',fontSize:'15px',fontWeight:800,color:isG?C.green:C.red,fontFamily:FONT_MONO}}>{s.score}</td>
                                <td style={{padding:'11px 14px',fontSize:'12px',color:C.muted}}>{s.odd}</td>
                                <td style={{padding:'11px 14px',fontSize:'12px',color:C.muted}}>R${fmt(s.stake)}</td>
                                <td style={{padding:'11px 14px',fontSize:'13px',fontWeight:700,color: s.lucro_real>=0 ? C.green : C.red,fontFamily:FONT_MONO}}>{s.lucro_real>=0?'+':''}R${fmt(Math.abs(s.lucro_real))}</td>
                                <td style={{padding:'11px 14px',fontSize:'12px',fontWeight:600,color: sRoi>=0 ? C.green : C.red,fontFamily:FONT_MONO}}>{sRoi>=0?'+':''}{sRoi.toFixed(1)}%</td>
                                <td style={{padding:'11px 14px'}}>
                                  <span style={{background: isG?C.greenDim:C.redDim,color:isG?C.green:C.red,border:`1px solid ${isG?'rgba(0,208,132,.3)':'rgba(255,77,77,.3)'}`,borderRadius:'20px',padding:'3px 10px',fontSize:'10px',fontWeight:800}}>
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
        </main>
      </div>

      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulseOrange{0%,100%{box-shadow:0 0 0 0 rgba(255,122,0,.4)}60%{box-shadow:0 0 0 6px rgba(255,122,0,0)}}
        input:focus,textarea:focus{border-color:${C.orangeBorder}!important;box-shadow:0 0 0 3px ${C.orangeDim}}
        button:hover{opacity:.88}
        @media(max-width:760px){
          .app-shell{flex-direction:column!important}
          .nav-rail{
            flex-direction:row!important;width:100%!important;height:auto!important;
            position:sticky!important;top:56px!important;border-right:none!important;
            border-bottom:1px solid ${C.border};padding:8px 10px!important;
            overflow-x:auto;justify-content:center;
          }
          .nav-rail button{flex-direction:row!important;padding:8px 12px!important;margin:0 4px!important}
          .verdict-card{flex-direction:column;text-align:center}
          .criteria-split{flex-direction:column}
          .criteria-split > div:nth-child(2){width:100%!important;height:1px!important}
          .kpi-grid{grid-template-columns:repeat(2,1fr)!important}
        }
      `}</style>
    </div>
  );
}
