import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import AuthGate from '@/components/AuthGate';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'SWAT2 - Workflow Testing',
  description: 'Optimized System Workflow Automation Tool',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
