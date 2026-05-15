import Head from 'next/head';
import Link from 'next/link';
import { ReactNode } from 'react';

interface LayoutProps {
  children: ReactNode;
  lastUpdated?: string;
}

export default function Layout({ children, lastUpdated }: LayoutProps) {
  return (
    <>
      <Head>
        <title>sg-layoffz — Singapore Layoff Tracker</title>
        <meta name="description" content="Tracking layoffs and retrenchments across Singapore companies." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className="min-h-screen flex flex-col">
        <header className="sticky top-0 z-50 bg-white border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <Link href="/" className="flex items-center gap-2">
                <span className="text-xl font-bold text-gray-900">
                  sg-layoffz
                </span>
                <span className="hidden sm:inline text-sm text-gray-500">Singapore Layoff Tracker</span>
              </Link>
              <nav className="flex items-center gap-6">
                <Link href="/" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
                  Data
                </Link>
                <Link href="/about" className="text-sm text-gray-600 hover:text-gray-900 transition-colors">
                  About
                </Link>
              </nav>
            </div>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="bg-gray-50 border-t border-gray-200 mt-16">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="text-sm text-gray-500">
                Built with ❤️ by{' '}
                <a
                  href="https://github.com/luarss"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-900 font-medium hover:underline"
                >
                  luarss
                </a>
              </div>
              <div className="text-xs text-gray-400 flex flex-col sm:flex-row gap-2 sm:gap-4">
                <span>Data sourced from public news reports. Not affiliated with any government agency.</span>
                {lastUpdated && <span>Last updated: {lastUpdated}</span>}
              </div>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
