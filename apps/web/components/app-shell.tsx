'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { clearToken } from '../lib/api';

const navItems = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/integrations', label: 'Integrações' },
  { href: '/contacts', label: 'Contatos & Listas' },
  { href: '/library', label: 'Biblioteca' },
  { href: '/campaigns', label: 'Campanhas' },
  { href: '/results', label: 'Resultados' },
];

export function AppShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Campaign Sender</p>
          <h1>Piloto WhatsApp</h1>
        </div>

        <nav className="nav">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={pathname === item.href ? 'nav-link active' : 'nav-link'}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <button
          className="ghost-button"
          onClick={() => {
            clearToken();
            router.replace('/login');
          }}
        >
          Sair
        </button>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <p className="eyebrow">Operação guiada</p>
            <h2>{title}</h2>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
