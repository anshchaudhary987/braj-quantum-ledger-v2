import React from 'react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center p-6">
      <div className="text-center">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-500 to-teal-600 flex items-center justify-center mx-auto mb-6 shadow-lg shadow-teal-500/25">
          <span className="text-white font-bold text-2xl">₹</span>
        </div>
        <h1 className="text-6xl font-bold text-white mb-4">404</h1>
        <p className="text-slate-400 text-lg mb-8">Page not found</p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-gradient-to-r from-teal-500 to-sky-500 text-white font-medium hover:from-teal-600 hover:to-sky-600 transition-all"
        >
          Go Home
        </Link>
      </div>
    </div>
  );
}
