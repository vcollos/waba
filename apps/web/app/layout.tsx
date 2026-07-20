// Ordem importa: legacy.css (telas ainda-não-migradas) carrega antes; o DS
// Collos em globals.css carrega depois e vence em tudo que é compartilhado.
import './legacy.css';
import './globals.css';
import { AuthGuard } from '../components/auth-guard';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'WABA Collos',
  description: 'Plataforma multi-tenant de WhatsApp Business — Collos',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>
        <AuthGuard>{children}</AuthGuard>
      </body>
    </html>
  );
}
