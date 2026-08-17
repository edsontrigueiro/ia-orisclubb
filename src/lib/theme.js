// ── ORIS CLUB — design tokens compartilhados ──
// Alinhado ao Brand Content Playbook v1.1: preto profundo + laranja canônico
// #FF5E04 (amostrado da logo original do PDF; mesmo theme-color da landing
// links.orisclub.club) como ÚNICA cor de marca, usada com escassez — cap. 05
// (calma/autoridade) e cap. 13 (minimalismo). Verde/vermelho são reservados
// para semântica de RESULTADO REAL (green/red do sinal) — nunca para score,
// aprovação ou UI, pra não confundir "nota da casa" com "veredito do jogo".
export const C = {
  bg: '#0A0A0A',
  bg2: '#111111',
  bg3: '#161616',
  bg4: '#1D1D1D',
 
  orange: '#FF5E04',
  orangeGlow: '#FF7A33',
  orangeDim: 'rgba(255,94,4,.10)',
  orangeBorder: 'rgba(255,94,4,.30)',
 
  text: '#F5F3EF',
  muted: '#9A9A9A',
  muted2: '#5C5C5C',
  muted3: '#2E2E2E',
 
  border: 'rgba(255,255,255,.07)',
  borderOrange: 'rgba(255,94,4,.28)',
 
  // Semântico — não mudar conforme a marca
  green: '#00D084',
  greenDim: 'rgba(0,208,132,.1)',
  red: '#FF4D4D',
  redDim: 'rgba(255,77,77,.1)',
};
 
// Tipografia da marca (mesma da landing): Archivo caps pra display/números,
// Inter no corpo, JetBrains Mono pra metadados técnicos e microtítulos.
export const FONT_DISPLAY = "'Archivo', system-ui, sans-serif";
export const FONT_BODY = "'Inter', system-ui, sans-serif";
export const FONT_MONO = "'JetBrains Mono', monospace";
 
export const FONT_LINKS_HREF =
  'https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800;900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap';
 
// Logo oficial (mesmo arquivo da landing VSL): símbolo hachurado + wordmark.
// Servida de /public — some ~14 KB de base64 do bundle e o navegador cacheia.
// Altura natural 132px; usar height 26-34px no CSS, sempre com width:'auto'.
export const LOGO_SRC = '/oris-logo.png';
