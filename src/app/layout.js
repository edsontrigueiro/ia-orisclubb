import { FONT_LINKS_HREF } from '@/lib/theme';

export const metadata = {
  title: 'Oris Club',
  description: 'Camada de inteligência para operações esportivas',
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
