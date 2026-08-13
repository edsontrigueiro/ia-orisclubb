'use client';

import { useEffect, useMemo, useState } from 'react';

const MERCADOS = [
  { valor: '', label: 'Todos os mercados' },
  { valor: 'lay2x2', label: 'Lay 2x2' },
  { valor: 'mais15', label: '+1.5 Gols' },
  { valor: 'layempate', label: 'Lay Empate' },
  { valor: 'under35', label: 'Under 3.5 Gols' },
  { valor: 'mais05gols1t', label: '+0.5 Gols 1T' },
  { valor: 'escanteios85', label: '+8.5 Escanteios' },
  { valor: 'duplachance', label: 'Dupla Chance' },
  { valor: 'menos25gols1t', label: '-2.5 Gols 1T' },
  { valor: 'mais05gols', label: '+0.5 Gols' },
  { valor: 'bttsnao', label: 'BTTS Nao' },
];

const LABEL_MERCADO = Object.fromEntries(MERCADOS.filter((m) => m.valor).map((m) => [m.valor, m.label]));

function formatarData(iso) {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function Dashboard() {
  const [registros, setRegistros] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(null);
  const [isDemo, setIsDemo] = useState(false);
  const [filtroMercado, setFiltroMercado] = useState('');
  const [filtroAprovado, setFiltroAprovado] = useState('');
  const [busca, setBusca] = useState('');

  useEffect(() => {
    let cancelado = false;
    async function carregar() {
      setCarregando(true);
      setErro(null);
      try {
        const params = new URLSearchParams();
        if (filtroMercado) params.set('mercado', filtroMercado);
        if (filtroAprovado) params.set('aprovado', filtroAprovado);
        params.set('limit', '200');
        const res = await fetch(`/api/demo-historico?${params.toString()}`);
        const data = await res.json();
        if (cancelado) return;
        if (!res.ok) {
          setErro(data.error ? `${data.error}${data.detalhe ? ' — ' + data.detalhe : ''}` : 'Erro ao carregar historico.');
          setRegistros([]);
        } else {
          setRegistros(data.data || []);
          setIsDemo(!!data._demo);
        }
      } catch (err) {
        if (!cancelado) setErro('Falha ao chamar a API: ' + err.message);
      } finally {
        if (!cancelado) setCarregando(false);
      }
    }
    carregar();
    return () => { cancelado = true; };
  }, [filtroMercado, filtroAprovado]);

  const registrosFiltrados = useMemo(() => {
    if (!busca.trim()) return registros;
    const termo = busca.trim().toLowerCase();
    return registros.filter(
      (r) => r.time_a?.toLowerCase().includes(termo) || r.time_b?.toLowerCase().includes(termo)
    );
  }, [registros, busca]);

  const stats = useMemo(() => {
    const total = registrosFiltrados.length;
    const aprovados = registrosFiltrados.filter((r) => r.aprovado_final).length;
    const taxaAprovacao = total ? Math.round((aprovados / total) * 100) : 0;
    const scoreMedio = total
      ? Math.round(registrosFiltrados.reduce((acc, r) => acc + (Number(r.score) || 0), 0) / total)
      : 0;

    const porMercado = {};
    registrosFiltrados.forEach((r) => {
      if (!porMercado[r.mercado]) porMercado[r.mercado] = { total: 0, aprovados: 0 };
      porMercado[r.mercado].total += 1;
      if (r.aprovado_final) porMercado[r.mercado].aprovados += 1;
    });
    const rankingMercados = Object.entries(porMercado)
      .map(([mercado, v]) => ({
        mercado,
        total: v.total,
        aprovados: v.aprovados,
        taxa: v.total ? Math.round((v.aprovados / v.total) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total);

    return { total, aprovados, taxaAprovacao, scoreMedio, rankingMercados };
  }, [registrosFiltrados]);

  return (
    <main style={estilos.pagina}>
      <div style={estilos.cabecalho}>
        <div>
          <h1 style={estilos.titulo}>ORIS Club — Dashboard (Demo)</h1>
          <p style={estilos.subtitulo}>
            Historico de analises do motor de criterios — versao isolada de demonstracao.{' '}
            <a href="/demo-dashboard/nova-analise.html" style={estilos.link}>Testar nova analise →</a>
          </p>
        </div>
        {isDemo && <span style={estilos.badgeDemo}>MODO DEMO</span>}
      </div>

      <section style={estilos.filtros}>
        <div style={estilos.campoFiltro}>
          <label style={estilos.label}>Mercado</label>
          <select
            value={filtroMercado}
            onChange={(e) => setFiltroMercado(e.target.value)}
            style={estilos.select}
          >
            {MERCADOS.map((m) => (
              <option key={m.valor} value={m.valor}>{m.label}</option>
            ))}
          </select>
        </div>
        <div style={estilos.campoFiltro}>
          <label style={estilos.label}>Status</label>
          <select
            value={filtroAprovado}
            onChange={(e) => setFiltroAprovado(e.target.value)}
            style={estilos.select}
          >
            <option value="">Todos</option>
            <option value="true">Aprovados</option>
            <option value="false">Reprovados</option>
          </select>
        </div>
        <div style={{ ...estilos.campoFiltro, flex: 1, minWidth: 180 }}>
          <label style={estilos.label}>Buscar time</label>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Ex: Flamengo"
            style={estilos.input}
          />
        </div>
      </section>

      {erro && <div style={estilos.erro}>{erro}</div>}

      <section style={estilos.cards}>
        <CardStat label="Total de analises" valor={stats.total} />
        <CardStat label="Aprovadas" valor={stats.aprovados} />
        <CardStat label="Taxa de aprovacao" valor={`${stats.taxaAprovacao}%`} />
        <CardStat label="Score medio" valor={stats.scoreMedio} />
      </section>

      <section style={estilos.bloco}>
        <h2 style={estilos.tituloBloco}>Taxa de aprovacao por mercado</h2>
        {carregando ? (
          <p style={estilos.texto}>Carregando...</p>
        ) : stats.rankingMercados.length === 0 ? (
          <p style={estilos.texto}>Nenhum registro para os filtros selecionados.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
            {stats.rankingMercados.map((m) => (
              <div key={m.mercado} style={estilos.linhaBarra}>
                <div style={estilos.rotuloBarra}>
                  {LABEL_MERCADO[m.mercado] || m.mercado}
                  <span style={estilos.rotuloBarraSub}> ({m.total})</span>
                </div>
                <div style={estilos.trilhaBarra}>
                  <div style={{ ...estilos.preenchimentoBarra, width: `${m.taxa}%` }} />
                </div>
                <div style={estilos.valorBarra}>{m.taxa}%</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={estilos.bloco}>
        <h2 style={estilos.tituloBloco}>
          Analises recentes {!carregando && `(${registrosFiltrados.length})`}
        </h2>
        {carregando ? (
          <p style={estilos.texto}>Carregando...</p>
        ) : registrosFiltrados.length === 0 ? (
          <p style={estilos.texto}>Nenhum registro encontrado.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={estilos.tabela}>
              <thead>
                <tr>
                  <th style={estilos.th}>Confronto</th>
                  <th style={estilos.th}>Mercado</th>
                  <th style={estilos.th}>Score</th>
                  <th style={estilos.th}>Status</th>
                  <th style={estilos.th}>Lado</th>
                  <th style={estilos.th}>Data</th>
                </tr>
              </thead>
              <tbody>
                {registrosFiltrados.map((r) => (
                  <tr key={r.id}>
                    <td style={estilos.td}>{r.time_a} x {r.time_b}</td>
                    <td style={estilos.td}>{LABEL_MERCADO[r.mercado] || r.mercado}</td>
                    <td style={estilos.td}>{r.score ?? '—'}</td>
                    <td style={estilos.td}>
                      <span style={r.aprovado_final ? estilos.badgeOk : estilos.badgeNo}>
                        {r.aprovado_final ? 'Aprovado' : 'Reprovado'}
                      </span>
                    </td>
                    <td style={estilos.td}>{r.lado_aprovado || '—'}</td>
                    <td style={estilos.td}>{formatarData(r.criado_em)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function CardStat({ label, valor }) {
  return (
    <div style={estilos.card}>
      <div style={estilos.cardLabel}>{label}</div>
      <div style={estilos.cardValor}>{valor}</div>
    </div>
  );
}

const estilos = {
  pagina: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    maxWidth: 980,
    margin: '0 auto',
    padding: '2.5rem 1.5rem 4rem',
    color: '#1a1a1a',
    background: '#fafafa',
    minHeight: '100vh',
  },
  cabecalho: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '2rem',
    flexWrap: 'wrap',
    gap: '.75rem',
  },
  titulo: { fontSize: '1.6rem', margin: 0 },
  subtitulo: { color: '#666', marginTop: '.35rem', marginBottom: 0, fontSize: '.9rem' },
  link: { color: '#111', fontWeight: 600 },
  badgeDemo: {
    background: '#fef3c7', color: '#92400e', padding: '.25rem .7rem',
    borderRadius: 999, fontSize: '.75rem', fontWeight: 700, textTransform: 'uppercase',
    height: 'fit-content',
  },
  filtros: {
    display: 'flex', gap: '1rem', flexWrap: 'wrap',
    background: '#fff', border: '1px solid #e2e2e2', borderRadius: 10,
    padding: '1.25rem', marginBottom: '1.5rem',
  },
  campoFiltro: { minWidth: 160 },
  label: { fontSize: '.75rem', fontWeight: 600, color: '#444', display: 'block', marginBottom: '.3rem' },
  select: {
    width: '100%', padding: '.5rem .6rem', border: '1px solid #d5d5d5',
    borderRadius: 6, fontSize: '.9rem', background: '#fff',
  },
  input: {
    width: '100%', padding: '.5rem .6rem', border: '1px solid #d5d5d5',
    borderRadius: 6, fontSize: '.9rem',
  },
  erro: {
    background: '#fee2e2', color: '#991b1b', padding: '.9rem 1rem',
    borderRadius: 8, marginBottom: '1.5rem', fontSize: '.9rem',
  },
  cards: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: '1rem', marginBottom: '1.5rem',
  },
  card: {
    background: '#fff', border: '1px solid #e2e2e2', borderRadius: 10, padding: '1.1rem',
  },
  cardLabel: { fontSize: '.75rem', color: '#666', fontWeight: 600, textTransform: 'uppercase' },
  cardValor: { fontSize: '1.8rem', fontWeight: 800, marginTop: '.25rem' },
  bloco: {
    background: '#fff', border: '1px solid #e2e2e2', borderRadius: 10,
    padding: '1.25rem', marginBottom: '1.5rem',
  },
  tituloBloco: { fontSize: '1.05rem', margin: '0 0 1rem' },
  texto: { color: '#666', fontSize: '.9rem', margin: 0 },
  linhaBarra: { display: 'grid', gridTemplateColumns: '190px 1fr 46px', alignItems: 'center', gap: '.75rem' },
  rotuloBarra: { fontSize: '.85rem', fontWeight: 600 },
  rotuloBarraSub: { color: '#999', fontWeight: 400 },
  trilhaBarra: { background: '#f0f0f0', borderRadius: 999, height: 10, overflow: 'hidden' },
  preenchimentoBarra: { background: '#111', height: '100%', borderRadius: 999 },
  valorBarra: { fontSize: '.8rem', color: '#444', textAlign: 'right', fontWeight: 600 },
  tabela: { width: '100%', borderCollapse: 'collapse', fontSize: '.85rem' },
  th: {
    textAlign: 'left', padding: '.6rem .5rem', borderBottom: '2px solid #eee',
    color: '#666', fontSize: '.75rem', textTransform: 'uppercase',
  },
  td: { padding: '.6rem .5rem', borderBottom: '1px solid #f0f0f0' },
  badgeOk: {
    background: '#dcfce7', color: '#166534', padding: '.15rem .6rem',
    borderRadius: 999, fontSize: '.75rem', fontWeight: 700,
  },
  badgeNo: {
    background: '#fee2e2', color: '#991b1b', padding: '.15rem .6rem',
    borderRadius: 999, fontSize: '.75rem', fontWeight: 700,
  },
};
