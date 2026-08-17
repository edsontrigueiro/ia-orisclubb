import { FONT_LINKS_HREF } from '@/lib/theme';

export const metadata = {
  title: 'Oris Club',
  description: 'Camada de inteligência para operações esportivas',
  applicationName: 'Oris Club',
  manifest: '/manifest.webmanifest',

  // iOS não lê o manifest para o ícone da tela de início — ele exige
  // apple-touch-icon em PNG. Sem esta linha o iPhone salva um print da tela.
  icons: {
    apple: [{ url: '/icons/apple-180.png', sizes: '180x180', type: 'image/png' }],
  },

  // Abre em tela cheia (sem barra do Safari) quando aberto pelo atalho.
  // statusBarStyle 'black' mantém a barra de status preta e NÃO joga o
  // conteúdo por baixo do notch — a topbar de 56px continua no lugar.
  appleWebApp: {
    capable: true,
    title: 'Oris',
    statusBarStyle: 'black',
  },

  formatDetection: { telephone: false },
};

export const viewport = {
  themeColor: '#0A0A0A',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="stylesheet" href={FONT_LINKS_HREF} />
      </head>
      <body style={{ margin: 0, padding: 0, background: '#0A0A0A', fontFamily: "'Inter', system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
