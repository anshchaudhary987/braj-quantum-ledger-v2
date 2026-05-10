import React from 'react';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Inventory — GLM Ledger',
  description: 'Inventory management',
};

export default function InventoryPage() {
  return (
    <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center p-6">
      <div className="text-center">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-500 to-teal-600 flex items-center justify-center mx-auto mb-6 shadow-lg shadow-teal-500/25">
          <span className="text-white font-bold text-2xl">₹</span>
        </div>
        <h1 className="text-3xl font-bold text-white mb-2">Inventory</h1>
        <p className="text-slate-400">Inventory management coming soon...</p>
      </div>
    </div>
  );
}
