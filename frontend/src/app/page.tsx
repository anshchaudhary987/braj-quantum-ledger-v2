'use client';

import React, { Suspense, lazy } from 'react';
import dynamic from 'next/dynamic';

// Lazy load heavy components for code splitting
const HeroSection = lazy(() => import('@/components/landing/HeroSection'));
const FeaturesSection = lazy(() => import('@/components/landing/FeaturesSection'));
const TrustSection = lazy(() => import('@/components/landing/TrustSection'));
const CTASection = lazy(() => import('@/components/landing/CTASection'));

// Dynamic import for the 3D background (very heavy)
const ImmersiveBackground = dynamic(
  () => import('@/components/3d/ImmersiveScene').then((mod) => mod.ImmersiveBackground),
  {
    ssr: false, // Don't SSR Three.js
    loading: () => <div className="absolute inset-0 bg-[#0F172A]" />,
  }
);

// Loading fallback component
function SectionFallback() {
  return (
    <div className="min-h-[50vh] flex items-center justify-center">
      <div className="animate-pulse">
        <div className="h-4 bg-white/10 rounded w-48 mb-4 mx-auto" />
        <div className="h-8 bg-white/10 rounded w-64 mx-auto" />
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <div className="relative min-h-screen bg-[#0F172A] overflow-x-hidden">
      {/* Full-screen 3D Immersive Background - Fixed behind everything */}
      <Suspense fallback={<div className="absolute inset-0 bg-[#0F172A]" />}>
        <ImmersiveBackground />
      </Suspense>
      
      {/* Content Layer */}
      <div className="relative z-10">
        <Suspense fallback={<SectionFallback />}>
          <HeroSection />
        </Suspense>
        <Suspense fallback={<SectionFallback />}>
          <FeaturesSection />
        </Suspense>
        <Suspense fallback={<SectionFallback />}>
          <TrustSection />
        </Suspense>
        <Suspense fallback={<SectionFallback />}>
          <CTASection />
        </Suspense>
        
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
