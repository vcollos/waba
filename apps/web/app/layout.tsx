import './globals.css';
import { AuthGuard } from '../components/auth-guard';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Campaign Sender Pilot',
  description: 'Pilot self-hosted para WhatsApp Business Platform',
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
