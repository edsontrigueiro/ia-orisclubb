// ── ORIS CLUB — design tokens compartilhados ──
// Paleta: fundo grafite profundo + laranja energético como única cor de marca.
// Verde/vermelho são reservados para semântica de resultado (aprovado/green
// vs reprovado/red) — nunca usados como cor de marca, pra não confundir
// "isso é a UI" com "isso é o veredito da IA".
export const C = {
  bg: '#0A0A0A',
  bg2: '#141414',
  bg3: '#1C1C1C',
  bg4: '#232323',

  orange: '#FF7A00',
  orangeGlow: '#FF9A40',
  orangeDim: 'rgba(255,122,0,.12)',
  orangeBorder: 'rgba(255,122,0,.28)',

  text: '#F5F3EF',
  muted: '#9A9A9A',
  muted2: '#5C5C5C',
  muted3: '#2E2E2E',

  border: 'rgba(255,255,255,.07)',
  borderOrange: 'rgba(255,122,0,.25)',

  // Semântico — não mudar conforme a marca
  green: '#00D084',
  greenDim: 'rgba(0,208,132,.1)',
  red: '#FF4D4D',
  redDim: 'rgba(255,77,77,.1)',
};

export const FONT_DISPLAY = "'Sora', system-ui, sans-serif";
export const FONT_BODY = "'Inter', system-ui, sans-serif";
export const FONT_MONO = "'JetBrains Mono', monospace";

export const FONT_LINKS_HREF =
  'https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap';
