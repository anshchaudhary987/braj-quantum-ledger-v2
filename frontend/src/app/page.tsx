import React from 'react';

// Server-safe imports (no client hooks)
import HeroSection from '@/components/landing/HeroSection';
import FeaturesSection from '@/components/landing/FeaturesSection';
import TrustSection from '@/components/landing/TrustSection';
import CTASection from '@/components/landing/CTASection';

export default function Home() {
  return (
    <div className="relative min-h-screen bg-[#0F172A] overflow-x-hidden">
      {/* Static gradient background (SSR safe) */}
      <div className="absolute inset-0 bg-gradient-to-b from-slate-900 via-[#0F172A] to-slate-900 z-0" />
      
      {/* Content Layer */}
      <div className="relative z-10">
        <HeroSection />
        <FeaturesSection />
        <TrustSection />
        <CTASection />
        
        {/* Footer */}
        <footer className="py-12 px-4 border-t border-white/10 bg-[#0F172A]/80 backdrop-blur-sm relative z-10">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-teal-500 flex items-center justify-center shadow-lg shadow-sky-500/25">
                <span className="text-white font-bold text-lg">₹</span>
              </div>
              <span className="text-slate-400 text-sm">© 2026 GLM Ledger. All rights reserved.</span>
            </div>
            <div className="flex items-center gap-6">
              <a href="#" className="text-slate-400 hover:text-sky-400 text-sm transition-colors">Privacy Policy</a>
              <a href="#" className="text-slate-400 hover:text-sky-400 text-sm transition-colors">Terms of Service</a>
              <a href="#" className="text-slate-400 hover:text-sky-400 text-sm transition-colors">Support</a>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
