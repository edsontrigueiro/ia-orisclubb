// Manifesto PWA — Next.js App Router serve este arquivo em /manifest.webmanifest
// e injeta o <link rel="manifest"> automaticamente.
// É ele que faz o "Adicionar à Tela de Início" instalar com a marca da Oris.

export const dynamic = 'force-static';

export default function manifest() {
  return {
    name: 'Oris Club',
    short_name: 'Oris',
    description: 'Camada de inteligência para operações esportivas',
    lang: 'pt-BR',
    id: '/app',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0A0A0A',
    theme_color: '#0A0A0A',
    categories: ['sports', 'productivity'],
    icons: [
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        // Android recorta o ícone em círculo/squircle: esta versão tem
        // margem de segurança para o símbolo não ser cortado.
        src: '/icons/maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
