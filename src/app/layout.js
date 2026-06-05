export const metadata = {
  title: 'Scanner Tips',
  description: 'Sistema de análise de sinais esportivos',
};
export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, padding: 0, background: '#070a08', fontFamily: 'Inter, system-ui, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
