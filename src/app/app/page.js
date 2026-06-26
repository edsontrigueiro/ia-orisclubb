'use client';
export const dynamic = 'force-dynamic';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { authFetch, getStoredToken, getStoredUser, clearSession } from '@/lib/clientSession';
import { C, FONT_DISPLAY, FONT_BODY, FONT_MONO } from '@/lib/theme';

const MKTS = [
  { id:'lay2x2',     label:'Lay 2x2',        min:82 },
  { id:'duplachance',label:'Dupla Chance',   min:86 },
  { id:'mais15',     label:'+1.5 Gols',      min:83 },
  { id:'mais05',     label:'+0.5 Gols',      min:88 },
  { id:'menos25',    label:'-2.5 Gols 1T',   min:86 },
  { id:'layempate',  label:'Lay Empate',     min:84 },
  { id:'under35',    label:'Under 3.5 Gols', min:85 },
  { id:'bttsnao',    label:'BTTS Não',       min:88 },
  { id:'mais05_1t',  label:'+0.5 Gols 1T',   min:85 },
  { id:'escanteios', label:'+8.5 Escanteios',min:85 },
];

const NAV = [
  { id:'analises',    label:'Análises',     icon:'M22 12h-4l-3 9L9 3l-3 9H2' },
  { id:'jogosdodia',  label:'Jogos do Dia', icon:'M8 2v4 M16 2v4 M3 10h18 M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' },
  { id:'historico',   label:'Histórico',    icon:'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z' },
  { id:'desempenho',  label:'Desempenho',   icon:'M23 6 13.5 15.5 8.5 10.5 1 18 M17 6 23 6 23 12' },
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

// Painel de estatísticas da grade do dia — sem IA, só dado (forma recente,
// últimos resultados, H2H, escanteios quando disponível).
function StatsPanel({ dados }) {
  function formatarData(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' });
    } catch { return ''; }
  }

  function resultadoJogo(j) {
    const partes = (j.placar || '?-?').split('-').map(Number);
    const [gh, ga] = partes;
    const golsPro = j.eh_casa ? gh : ga;
    const golsContra = j.eh_casa ? ga : gh;
    if (golsPro > golsContra) return { letra:'V', cor:C.green };
    if (golsPro < golsContra) return { letra:'D', cor:C.red };
    return { letra:'E', cor:C.muted };
  }

  // Bloco compacto de V-E-D + médias, reaproveitado pra geral/casa/fora.
  function ResumoForma({ titulo, forma }) {
    if (!forma) return (
      <div style={{fontSize:'10.5px',color:C.muted2,marginBottom:'4px'}}>{titulo}: sem dado</div>
    );
    return (
      <div style={{marginBottom:'6px'}}>
        <div style={{fontSize:'9.5px',fontWeight:700,color:C.muted2,letterSpacing:'.5px',textTransform:'uppercase',marginBottom:'2px'}}>{titulo}</div>
        <div style={{fontSize:'11.5px',color:C.text,fontFamily:FONT_MONO}}>
          {forma.vitorias}V {forma.empates}E {forma.derrotas}D
          <span style={{color:C.muted2}}> ({forma.jogos_considerados}j)</span>
          <span style={{color:C.muted}}> · {forma.media_gols_marcados}/{forma.media_gols_sofridos} gols</span>
        </div>
        {forma.primeiro_tempo && (
          <div style={{fontSize:'10.5px',color:C.orangeGlow,fontFamily:FONT_MONO,marginTop:'2px'}}>
            1T: {forma.primeiro_tempo.media_gols_marcados_1t}/{forma.primeiro_tempo.media_gols_sofridos_1t} gols
            <span style={{color:C.muted2}}> · {forma.primeiro_tempo.pct_jogos_1t_total_baixo}% até 2 gols no 1T</span>
          </div>
        )}
      </div>
    );
  }

  function ListaJogos({ jogos }) {
    if (!jogos || jogos.length === 0) return (
      <div style={{fontSize:'10.5px',color:C.muted2,marginTop:'4px'}}>Sem jogos recentes disponíveis.</div>
    );
    return (
      <div style={{marginTop:'8px'}}>
        <div style={{fontSize:'9.5px',fontWeight:700,color:C.muted2,letterSpacing:'.5px',textTransform:'uppercase',marginBottom:'4px'}}>Últimos jogos</div>
        <div style={{display:'flex',flexDirection:'column',gap:'3px'}}>
          {jogos.map((j, i) => {
            const { letra, cor } = resultadoJogo(j);
            const adversario = j.eh_casa ? j.fora : j.casa;
            return (
              <div key={i} style={{display:'flex',alignItems:'center',gap:'6px',fontSize:'10.5px'}}>
                <span style={{width:'15px',height:'15px',flexShrink:0,display:'inline-flex',alignItems:'center',justifyContent:'center',borderRadius:'3px',background:`${cor}22`,color:cor,fontWeight:800,fontSize:'8.5px',fontFamily:FONT_MONO}}>{letra}</span>
                <span style={{color:C.muted2,fontFamily:FONT_MONO,flexShrink:0}}>{formatarData(j.data)}</span>
                <span style={{color:C.muted,flexShrink:0}}>{j.eh_casa ? 'casa' : 'fora'}</span>
                <span style={{color:C.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1}}>{adversario}</span>
                <span style={{color:C.text,fontWeight:700,fontFamily:FONT_MONO,flexShrink:0}}>{j.placar}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function ColunaTime({ nome, forma, jogos }) {
    return (
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:'13px',fontWeight:700,color:C.text,marginBottom:'8px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{nome}</div>
        {forma ? (
          <>
            <ResumoForma titulo="Geral" forma={forma}/>
            <ResumoForma titulo="Em casa" forma={forma.como_mandante}/>
            <ResumoForma titulo="Fora" forma={forma.como_visitante}/>
            {forma.escanteios && (
              <div style={{fontSize:'11px',color:C.orangeGlow,marginBottom:'6px',fontFamily:FONT_MONO}}>
                ⛳ {forma.escanteios.media_escanteios} escanteios/jogo ({forma.escanteios.jogos_considerados}j)
              </div>
            )}
            <ListaJogos jogos={jogos}/>
          </>
        ) : (
          <div style={{fontSize:'11px',color:C.muted2}}>Sem dado disponível</div>
        )}
      </div>
    );
  }

  return (
    <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'10px',padding:'16px'}}>
      <div style={{display:'flex',gap:'20px',marginBottom:'16px',flexWrap:'wrap'}}>
        <ColunaTime nome={dados.time_a} forma={dados.forma_recente_time_a} jogos={dados.jogos_recentes_time_a}/>
        <div style={{width:'1px',background:C.border,flexShrink:0}}/>
        <ColunaTime nome={dados.time_b} forma={dados.forma_recente_time_b} jogos={dados.jogos_recentes_time_b}/>
      </div>

      {dados.modo_copa && (
        <div style={{fontSize:'10.5px',color:C.muted2,marginBottom:'10px',background:C.bg4,padding:'6px 9px',borderRadius:'6px'}}>
          🏆 Competição de copa/mata-mata — H2H raro e mando de campo menos relevante são esperados aqui.
        </div>
      )}

      {dados.escanteios_h2h && (
        <div style={{fontSize:'11px',color:C.orangeGlow,marginBottom:'10px',fontFamily:FONT_MONO}}>
          ⛳ H2H: média de {dados.escanteios_h2h.media_escanteios} escanteios/jogo ({dados.escanteios_h2h.jogos_considerados} jogos)
        </div>
      )}

      {dados.confrontos_diretos ? (
        <div>
          <div style={{fontSize:'10px',fontWeight:700,color:C.muted2,letterSpacing:'1px',textTransform:'uppercase',marginBottom:'7px'}}>Confrontos diretos ({dados.confrontos_diretos.length})</div>
          <div style={{display:'flex',flexDirection:'column',gap:'5px'}}>
            {dados.confrontos_diretos.map((h, i) => (
              <div key={i} style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'11px',color:C.muted,flexWrap:'wrap'}}>
                <span style={{color:C.muted2,fontFamily:FONT_MONO,flexShrink:0,width:'42px'}}>{formatarData(h.data)}</span>
                <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1,minWidth:'80px'}}>{h.casa} x {h.fora}</span>
                <span style={{fontFamily:FONT_MONO,fontWeight:700,color:C.text,flexShrink:0}}>{h.placar}</span>
                {h.placar_1t && <span style={{fontSize:'9.5px',color:C.muted2,fontFamily:FONT_MONO,flexShrink:0}}>(1T {h.placar_1t})</span>}
                {h.mesmo_mando_atual && <span style={{fontSize:'9px',color:C.orangeGlow,flexShrink:0,border:`1px solid ${C.orangeBorder}`,borderRadius:'4px',padding:'1px 4px'}}>mesmo mando</span>}
                {h.dias_atras != null && h.dias_atras > 730 && <span style={{fontSize:'9px',color:C.muted2,flexShrink:0}}>+2 anos</span>}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{fontSize:'11px',color:C.muted2}}>Sem confrontos diretos recentes disponíveis.</div>
      )}
    </div>
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
  const [saveError, setSaveError] = useState(null);

  // Histórico state
  const [signals, setSignals] = useState([]);
  const [loadingSignals, setLoadingSignals] = useState(false);
  const [updatingId, setUpdatingId] = useState(null);

  // Jogos do dia state
  const [jogosDoDia, setJogosDoDia] = useState([]);
  const [loadingJogos, setLoadingJogos] = useState(false);
  const [jogosError, setJogosError] = useState(null);
  const [dataJogos, setDataJogos] = useState(null);

  // Preview de estatísticas por jogo (botão "Ver estatísticas" na grade do
  // dia) — cache em memória por confronto, pra não rebuscar ao reabrir.
  const [statsAberto, setStatsAberto] = useState(null);
  const [statsCache, setStatsCache] = useState({});
  const [statsLoading, setStatsLoading] = useState(null);
  const [statsErro, setStatsErro] = useState({});

  // Saúde do sistema (substitui o "IA Online" estático por uma checagem real)
  const [health, setHealth] = useState(null);

  useEffect(() => {
    if (!authReady) return;
    (async () => {
      try {
        const { res } = await authFetch('/api/health');
        if (res?.ok) setHealth(await res.json());
      } catch {}
    })();
  }, [authReady]);

  useEffect(() => {
    const t = getStoredToken();
    if (!t) { router.push('/login'); return; }
    setUser(getStoredUser());
    setAuthReady(true);
  }, [router]);

  useEffect(() => {
    if (authReady && tab === 'historico') loadSignals();
    if (authReady && tab === 'desempenho') loadSignals();
    if (authReady && tab === 'jogosdodia' && jogosDoDia.length === 0 && !jogosError) loadJogosDoDia();
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

  const loadJogosDoDia = useCallback(async () => {
    setLoadingJogos(true); setJogosError(null);
    try {
      const { res, sessionExpired } = await authFetch('/api/jogos-do-dia');
      if (sessionExpired) { goToLoginExpired(); return; }
      const data = await res.json();
      if (!res.ok) { setJogosError(data?.error || 'Não foi possível carregar os jogos do dia.'); return; }
      setJogosDoDia(data.jogos || []);
      setDataJogos(data.data || null);
    } catch { setJogosError('Erro de conexão ao buscar os jogos do dia.'); }
    finally { setLoadingJogos(false); }
  }, []);

  // Clique num jogo da grade já leva pra Análises com o confronto preenchido.
  function analisarJogoDaGrade(timeA, timeB) {
    setJogo(`${timeA} vs ${timeB}`);
    setResult(null); setDecisao(null); setSaved(false);
    setTab('analises');
  }

  // Abre/fecha o painel de estatísticas de um jogo da grade do dia. Não
  // chama IA — é só dado real (forma recente, H2H, escanteios), com cache
  // local pra não rebuscar se o usuário fechar e abrir de novo.
  async function toggleStats(j) {
    const key = `${j.timeA}|${j.timeB}`;
    if (statsAberto === key) { setStatsAberto(null); return; }
    setStatsAberto(key);
    if (statsCache[key] || statsLoading === key) return;
    setStatsLoading(key);
    setStatsErro(prev => ({ ...prev, [key]: null }));
    try {
      const jogoStr = `${j.timeA} vs ${j.timeB}`;
      const { res, sessionExpired } = await authFetch(`/api/team-stats?jogo=${encodeURIComponent(jogoStr)}`);
      if (sessionExpired) { goToLoginExpired(); return; }
      const data = await res.json();
      if (!res.ok) { setStatsErro(prev => ({ ...prev, [key]: data?.error || 'Não foi possível carregar estatísticas.' })); return; }
      setStatsCache(prev => ({ ...prev, [key]: data }));
    } catch {
      setStatsErro(prev => ({ ...prev, [key]: 'Erro de conexão ao buscar estatísticas.' }));
    } finally {
      setStatsLoading(null);
    }
  }

  async function analyze() {
    if (!jogo.trim()) return;
    setAnalyzing(true); setResult(null); setDecisao(null); setSaved(false); setSaveError(null);
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
        setSaveError(null);
        setTimeout(() => {
          setJogo(''); setResult(null); setDecisao(null);
          setOdd(''); setStake(''); setSaved(false);
          // Vai pro Histórico — é justamente pra acompanhar o desempenho que
          // o sinal foi salvo; ficar na aba Análises com o formulário limpo
          // não mostrava nada do que acabou de ser salvo.
          setTab('historico');
        }, 1200);
      } else {
        // Antes essa falha era engolida em silêncio — o botão só voltava ao
        // normal sem explicar nada, e você ficava sem saber se salvou ou
        // não. Agora mostra o erro real (ex: restrição no banco rejeitando
        // um mercado novo) em vez de fingir que nada aconteceu.
        const data = await res.json().catch(() => ({}));
        setSaveError(data?.error || 'Não foi possível salvar o sinal. Tente novamente.');
      }
    } catch {
      setSaveError('Erro de conexão ao salvar o sinal. Tente novamente.');
    } finally { setSaving(false); }
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

  // A API devolve os sinais do mais novo pro mais antigo (pra exibir o
  // Histórico assim). Pra curva de lucro e drawdown fazerem sentido como
  // "evolução no tempo", precisam estar do mais ANTIGO pro mais novo —
  // inverter aqui, sem alterar a ordem usada no Histórico.
  const encerradosCron = [...encerrados].reverse();
  const lucroAcum = encerradosCron.reduce((acc, s, i) => {
    const prev = acc[i - 1] || 0;
    return [...acc, prev + (s.lucro_real || 0)];
  }, []);

  // Desempenho por mercado: a prova real de qual mercado está rendendo de
  // verdade com SEU dinheiro, em vez de só confiar no que a IA promete na
  // hora da análise. Ordenado por nº de sinais — mercado com 2 sinais não
  // prova nada ainda, mercado com 20 já mostra um padrão real.
  // Agrupa sinais encerrados por um campo (mercado ou competição) e calcula
  // win rate / ROI / lucro — mesma lógica servindo as duas quebras abaixo.
  function agruparDesempenho(lista, campo) {
    const grupos = {};
    for (const s of lista) {
      const chave = s[campo] || 'Não informado';
      if (!grupos[chave]) grupos[chave] = { chave, sinais: [], greens: 0, reds: 0, lucroTotal: 0, stakeTotal: 0 };
      const g = grupos[chave];
      g.sinais.push(s);
      if (s.resultado === 'green') g.greens++;
      else if (s.resultado === 'red') g.reds++;
      g.lucroTotal += s.lucro_real || 0;
      g.stakeTotal += s.stake || 0;
    }
    return Object.values(grupos)
      .map(g => ({
        chave: g.chave,
        nSinais: g.sinais.length,
        winRate: g.sinais.length ? (g.greens / g.sinais.length) * 100 : 0,
        roi: g.stakeTotal > 0 ? (g.lucroTotal / g.stakeTotal) * 100 : 0,
        lucroTotal: g.lucroTotal,
        greens: g.greens,
        reds: g.reds,
      }))
      .sort((a, b) => b.nSinais - a.nSinais);
  }

  const desempenhoPorMercado = agruparDesempenho(encerrados, 'mercado');
  const desempenhoPorLiga = agruparDesempenho(encerrados, 'competicao');

  // Drawdown máximo: a maior queda entre um pico e o fundo seguinte na curva
  // de lucro acumulado — a métrica que importa de verdade pra saber se a
  // banca aguenta uma fase ruim, não só o lucro total no fim. Calculado
  // sobre "encerrados" diretamente (não sobre "lucroAcum", que é indexado
  // por "signals" incluindo os "passar" — misturar os dois desalinha índice).
  const { drawdownMax, sequenciaRedsMax } = (() => {
    let acumulado = 0, pico = 0, drawdown = 0, sequencia = 0, sequenciaMax = 0;
    for (const s of encerradosCron) {
      acumulado += s.lucro_real || 0;
      if (acumulado > pico) pico = acumulado;
      const queda = pico - acumulado;
      if (queda > drawdown) drawdown = queda;
      if (s.resultado === 'red') { sequencia++; if (sequencia > sequenciaMax) sequenciaMax = sequencia; }
      else sequencia = 0;
    }
    return { drawdownMax: drawdown, sequenciaRedsMax: sequenciaMax };
  })();

  const mktInfo = MKTS.find(m => m.label === mkt) || MKTS[0];
  const lucPotencial = odd && stake ? ((parseFloat(stake) * parseFloat(odd)) - parseFloat(stake)) : null;

  // Sugestão de tamanho de entrada conforme a margem do score acima do
  // mínimo — não é um valor em R$ (não sabemos sua banca), é uma indicação
  // relativa: scores bem acima do mínimo justificam entrada mais forte,
  // scores raspando o mínimo pedem mais cautela mesmo "aprovados".
  const margemScore = result && !result._error ? (result.score - (result._minScore ?? mktInfo.min)) : null;
  const sizing = margemScore == null ? null
    : margemScore >= 15 ? { label: 'Entrada reforçada', desc: `Score ${margemScore} pontos acima do mínimo — sinal forte, considere uma entrada até 50% maior que sua entrada padrão.`, color: C.green }
    : margemScore >= 5  ? { label: 'Entrada padrão', desc: `Score ${margemScore} pontos acima do mínimo — dentro da faixa normal, mantenha sua entrada padrão.`, color: C.orangeGlow }
    : { label: 'Entrada cautelosa', desc: `Score só ${margemScore} pontos acima do mínimo — margem estreita, considere uma entrada menor que a padrão.`, color: C.red };

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

        {(() => {
          const footballOk = health?.football?.ok;
          const anthropicOk = health?.anthropic?.ok;
          const tudoOk = footballOk && anthropicOk;
          const cor = health === null ? C.muted2 : tudoOk ? C.orange : C.red;
          const corTexto = health === null ? C.muted : tudoOk ? C.orangeGlow : C.red;
          const label = health === null ? 'Verificando...' : tudoOk ? 'Sistemas OK' : 'Verificar APIs';
          const titulo = health
            ? `API-Football: ${footballOk ? 'OK' : (health.football?.motivo || 'falha')}${health.football?.requestsUsadas != null ? ` (${health.football.requestsUsadas}/${health.football.requestsLimite} hoje)` : ''} · Anthropic: ${anthropicOk ? 'configurada' : 'não configurada'}`
            : 'Checando status das APIs...';
          return (
            <div title={titulo} style={{display:'flex',alignItems:'center',gap:'5px',background: tudoOk || health===null ? C.orangeDim : C.redDim,border:`1px solid ${tudoOk || health===null ? C.orangeBorder : 'rgba(255,77,77,.3)'}`,borderRadius:'7px',padding:'5px 11px',cursor:'help'}}>
              <div style={{width:'6px',height:'6px',borderRadius:'50%',background:cor,animation: health===null ? 'none' : 'pulseOrange 2s infinite'}}/>
              <span style={{fontSize:'10px',fontWeight:700,color:corTexto,letterSpacing:'.5px',textTransform:'uppercase'}}>{label}</span>
            </div>
          );
        })()}

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
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={t.icon}/>
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
                  placeholder={"Ex: Arsenal vs Chelsea\nEx: River Plate (Uruguai) vs Nacional"}
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
                            {result._oddsReais && (
                              <div style={{marginTop:'8px',fontSize:'11px',color:C.orangeGlow,fontFamily:FONT_MONO}}>
                                {result._oddsReais.odd_media != null && `Odd real do mercado (${result._oddsReais.valor}): ${result._oddsReais.odd_media}`}
                                {result._oddsReais.odd_1x_time_a != null && `Odd real — 1X: ${result._oddsReais.odd_1x_time_a} · X2: ${result._oddsReais.odd_x2_time_b}`}
                                <span style={{color:C.muted2}}> (média de {result._oddsReais.casas_consultadas} casas)</span>
                              </div>
                            )}
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
                          <>
                          {sizing && (
                            <div style={{background:`${sizing.color}14`,border:`1px solid ${sizing.color}40`,borderRadius:'8px',padding:'10px 13px',marginBottom:'12px',display:'flex',alignItems:'flex-start',gap:'8px'}}>
                              <span style={{fontSize:'10px',fontWeight:800,color:sizing.color,letterSpacing:'1px',textTransform:'uppercase',whiteSpace:'nowrap'}}>{sizing.label}</span>
                              <span style={{fontSize:'11px',color:C.muted,lineHeight:1.5}}>{sizing.desc}</span>
                            </div>
                          )}
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
                          </>
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
                        {saveError && (
                          <div style={{marginTop:'10px',background:C.redDim,border:'1px solid rgba(255,77,77,.3)',borderRadius:'8px',padding:'10px 13px',fontSize:'12px',color:C.red,lineHeight:1.5}}>
                            ⚠️ {saveError}
                          </div>
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

          {/* ════ JOGOS DO DIA ════ */}
          {tab === 'jogosdodia' && (
            <div>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'20px',flexWrap:'wrap',gap:'10px'}}>
                <div>
                  <div style={{fontSize:'21px',fontWeight:800,letterSpacing:'-.3px',marginBottom:'4px',fontFamily:FONT_DISPLAY}}>Jogos do Dia</div>
                  <div style={{fontSize:'13px',color:C.muted}}>
                    {dataJogos ? new Date(dataJogos + 'T12:00:00').toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long' }) : 'Grade completa, atualiza sozinha a cada dia'}
                    {jogosDoDia.length > 0 && ` · ${jogosDoDia.length} jogos`}
                  </div>
                </div>
                <button onClick={loadJogosDoDia} style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'8px',padding:'8px 14px',fontSize:'12px',color:C.muted,cursor:'pointer',fontFamily:'inherit',display:'flex',alignItems:'center',gap:'6px'}}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.49-8.18"/></svg>
                  Atualizar
                </button>
              </div>

              {loadingJogos ? (
                <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:'14px',padding:'48px'}}>
                  <div style={{width:'40px',height:'40px',border:`3px solid ${C.orangeDim}`,borderTopColor:C.orange,borderRadius:'50%',animation:'spin .8s linear infinite'}}/>
                  <div style={{fontSize:'13px',color:C.muted}}>Buscando a grade do dia...</div>
                </div>
              ) : jogosError ? (
                <div style={{background:C.redDim,border:`1px solid rgba(255,77,77,.35)`,borderRadius:'14px',padding:'14px 16px',display:'flex',alignItems:'flex-start',gap:'10px'}}>
                  <span style={{fontSize:'18px',lineHeight:1}}>⚠️</span>
                  <div>
                    <div style={{fontSize:'13px',fontWeight:800,color:C.red,letterSpacing:'.3px'}}>FALHA AO CARREGAR</div>
                    <div style={{fontSize:'12px',color:C.muted,marginTop:'3px',lineHeight:1.5}}>{jogosError}</div>
                  </div>
                </div>
              ) : jogosDoDia.length === 0 ? (
                <div style={{background:C.bg3,border:`1px dashed ${C.border}`,borderRadius:'14px',padding:'48px 24px',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',gap:'14px'}}>
                  <div style={{width:'52px',height:'52px',borderRadius:'50%',background:C.orangeDim,border:`1px solid ${C.orangeBorder}`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={C.orange} strokeWidth="1.5"><path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>
                  </div>
                  <div style={{fontSize:'15px',fontWeight:700,fontFamily:FONT_DISPLAY}}>Nenhum jogo encontrado pra hoje</div>
                  <div style={{fontSize:'13px',color:C.muted,maxWidth:'280px',lineHeight:1.7}}>Pode ser dia de pausa nas principais ligas, ou a API ainda não publicou a grade.</div>
                </div>
              ) : (
                (() => {
                  // Agrupa por liga mantendo a ordem que já veio do backend
                  // (ligas prioritárias primeiro, resto em ordem alfabética).
                  const grupos = [];
                  for (const j of jogosDoDia) {
                    const ultimo = grupos[grupos.length - 1];
                    if (ultimo && ultimo.liga === j.liga) ultimo.jogos.push(j);
                    else grupos.push({ liga: j.liga, pais: j.pais, jogos: [j] });
                  }
                  return (
                    <div style={{display:'flex',flexDirection:'column',gap:'18px'}}>
                      {grupos.map((g, gi) => (
                        <div key={gi}>
                          <div style={{display:'flex',alignItems:'center',gap:'8px',marginBottom:'8px',paddingLeft:'2px'}}>
                            <div style={{fontSize:'12px',fontWeight:700,color:C.text}}>{g.liga}</div>
                            {g.pais && <div style={{fontSize:'10px',color:C.muted2}}>{g.pais}</div>}
                          </div>
                          <div style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'12px',overflow:'hidden'}}>
                            {g.jogos.map((j, ji) => {
                              const aoVivo = ['1H','2H','HT','ET','P','LIVE'].includes(j.status);
                              const finalizado = ['FT','AET','PEN'].includes(j.status);
                              const horaFormatada = j.hora
                                ? new Date(j.hora).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })
                                : '--:--';
                              const statsKey = `${j.timeA}|${j.timeB}`;
                              const statsVisiveis = statsAberto === statsKey;
                              return (
                                <div key={j.id || ji} style={{
                                  borderBottom: ji < g.jogos.length - 1 ? `1px solid ${C.border}` : 'none',
                                }}>
                                  <div style={{display:'flex',alignItems:'center',gap:'8px',padding:'12px 14px'}}>
                                    <button onClick={() => analisarJogoDaGrade(j.timeA, j.timeB)} style={{
                                      flex:1,minWidth:0,display:'flex',alignItems:'center',gap:'12px',
                                      background:'none',border:'none',padding:0,
                                      cursor:'pointer',fontFamily:'inherit',textAlign:'left',
                                    }}>
                                      <div style={{width:'52px',flexShrink:0,fontSize:'12px',fontFamily:FONT_MONO,color: aoVivo ? C.green : C.muted2,fontWeight: aoVivo ? 700 : 500}}>
                                        {aoVivo ? `${j.minuto ?? ''}'` : finalizado ? 'FIM' : horaFormatada}
                                      </div>
                                      <div style={{flex:1,minWidth:0,display:'flex',alignItems:'center',justifyContent:'space-between',gap:'8px'}}>
                                        <span style={{fontSize:'13px',color:C.text,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                                          {j.timeA} <span style={{color:C.muted2}}>x</span> {j.timeB}
                                        </span>
                                        {(aoVivo || finalizado) && (
                                          <span style={{fontSize:'13px',fontFamily:FONT_MONO,fontWeight:700,color: aoVivo ? C.green : C.muted,flexShrink:0}}>
                                            {j.golsA ?? 0}-{j.golsB ?? 0}
                                          </span>
                                        )}
                                      </div>
                                    </button>
                                    {/* Botão separado do clique de analisar — abre o preview de
                                        estatísticas (forma recente, H2H, escanteios) sem IA. */}
                                    <button onClick={() => toggleStats(j)} title="Ver estatísticas" style={{
                                      flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center',
                                      width:'28px',height:'28px',borderRadius:'7px',
                                      background: statsVisiveis ? C.orangeDim : C.bg4,
                                      border:`1px solid ${statsVisiveis ? C.orangeBorder : C.border}`,
                                      cursor:'pointer',
                                    }}>
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={statsVisiveis ? C.orange : C.muted} strokeWidth="2">
                                        <path d="M18 20V10M12 20V4M6 20v-6"/>
                                      </svg>
                                    </button>
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.muted2} strokeWidth="2" style={{flexShrink:0}} onClick={() => analisarJogoDaGrade(j.timeA, j.timeB)}><polyline points="9 18 15 12 9 6"/></svg>
                                  </div>

                                  {statsVisiveis && (
                                    <div style={{padding:'4px 14px 16px',background:C.bg2}}>
                                      {statsLoading === statsKey ? (
                                        <div style={{display:'flex',alignItems:'center',gap:'10px',padding:'14px 4px',fontSize:'12px',color:C.muted}}>
                                          <div style={{width:'16px',height:'16px',border:`2px solid ${C.orangeDim}`,borderTopColor:C.orange,borderRadius:'50%',animation:'spin .7s linear infinite'}}/>
                                          Buscando estatísticas...
                                        </div>
                                      ) : statsErro[statsKey] ? (
                                        <div style={{fontSize:'12px',color:C.red,padding:'10px 4px'}}>⚠️ {statsErro[statsKey]}</div>
                                      ) : statsCache[statsKey] ? (
                                        <StatsPanel dados={statsCache[statsKey]} />
                                      ) : null}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()
              )}
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
                  <div className="kpi-grid" style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:'12px',marginBottom:'20px'}}>
                    {[
                      {label:'ROI',value:`${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`,color: roi >= 0 ? C.green : C.red,sub:'sobre stake total'},
                      {label:'Lucro Total',value:`${lucroTotal >= 0 ? '+' : ''}R$${fmt(Math.abs(lucroTotal))}`,color: lucroTotal >= 0 ? C.green : C.red,sub:`${encerrados.length} sinais`},
                      {label:'Win Rate',value:`${winRate.toFixed(0)}%`,color: winRate >= 50 ? C.green : C.red,sub:`${greens.length}G / ${reds.length}R`},
                      {label:'Sinais Pegados',value:pegados.length,color:C.text,sub:`${encerrados.length} encerrados`},
                      {label:'Drawdown Máx.',value:`R$${fmt(drawdownMax)}`,color: drawdownMax > 0 ? C.red : C.muted,sub:'maior queda do pico'},
                      {label:'Sequência Negativa',value:sequenciaRedsMax,color: sequenciaRedsMax >= 3 ? C.red : C.text,sub:'reds seguidos, máx.'},
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
                      <div style={{fontSize:'11px',color:C.muted,marginBottom:'16px'}}>Evolução sinal a sinal, do mais antigo pro mais recente</div>
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

                  {/* Desempenho por mercado/liga — a prova real, com dado seu, de
                      o que de fato performa, em vez de só a promessa da IA no
                      momento da análise. */}
                  {[
                    { titulo: 'Desempenho por Mercado', dados: desempenhoPorMercado },
                    { titulo: 'Desempenho por Liga/Competição', dados: desempenhoPorLiga },
                  ].map(({ titulo, dados }) => dados.length > 0 && (
                    <div key={titulo} style={{background:C.bg3,border:`1px solid ${C.border}`,borderRadius:'14px',overflow:'hidden',marginBottom:'16px'}}>
                      <div style={{padding:'13px 16px',borderBottom:`1px solid ${C.border}`,fontSize:'13px',fontWeight:700}}>{titulo}</div>
                      <div style={{overflowX:'auto'}}>
                        <table style={{width:'100%',borderCollapse:'collapse',minWidth:'480px'}}>
                          <thead>
                            <tr style={{background:C.bg4}}>
                              {[titulo.includes('Liga') ? 'Liga/Competição' : 'Mercado','Sinais','Win Rate','ROI','Lucro Total'].map(h => (
                                <th key={h} style={{padding:'9px 14px',fontSize:'9.5px',fontWeight:700,letterSpacing:'1.2px',textTransform:'uppercase',color:C.muted2,textAlign:'left',whiteSpace:'nowrap'}}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {dados.map((m) => (
                              <tr key={m.chave} style={{borderBottom:`1px solid ${C.border}`}}>
                                <td style={{padding:'11px 14px',fontSize:'12.5px',color:C.text,fontWeight:600,whiteSpace:'nowrap'}}>{m.chave}</td>
                                <td style={{padding:'11px 14px',fontSize:'12px',color:C.muted}}>
                                  {m.nSinais} <span style={{color:C.muted2}}>({m.greens}G/{m.reds}R)</span>
                                  {m.nSinais < 10 && <span style={{color:C.orangeGlow,marginLeft:'6px',fontSize:'10px'}}>amostra pequena</span>}
                                </td>
                                <td style={{padding:'11px 14px',fontSize:'13px',fontWeight:700,color: m.winRate >= 50 ? C.green : C.red,fontFamily:FONT_MONO}}>{m.winRate.toFixed(0)}%</td>
                                <td style={{padding:'11px 14px',fontSize:'12px',fontWeight:600,color: m.roi >= 0 ? C.green : C.red,fontFamily:FONT_MONO}}>{m.roi>=0?'+':''}{m.roi.toFixed(1)}%</td>
                                <td style={{padding:'11px 14px',fontSize:'13px',fontWeight:700,color: m.lucroTotal>=0 ? C.green : C.red,fontFamily:FONT_MONO}}>{m.lucroTotal>=0?'+':''}R${fmt(Math.abs(m.lucroTotal))}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ))}

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
        @media(max-width:900px){
          .kpi-grid{grid-template-columns:repeat(3,1fr)!important}
        }
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
