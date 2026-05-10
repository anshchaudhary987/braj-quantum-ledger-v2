'use client';

import React, { Suspense, lazy } from 'react';
import { useSpring, animated, config } from '@react-spring/web';
import Sidebar3D from '@/components/dashboard/Sidebar3D';
import TopBar from '@/components/dashboard/TopBar';

// Lazy load dashboard components for code splitting
const KpiCards = lazy(() => import('@/components/dashboard/KpiCards'));
const ChartSection = lazy(() => import('@/components/dashboard/ChartSection'));
const GstWidget = lazy(() => import('@/components/dashboard/GstWidget'));
const QuickActions = lazy(() => import('@/components/dashboard/QuickActions'));

// Loading skeleton for lazy components
function DashboardSkeleton() {
  return (
    <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center">
      <div className="text-center">
        <animated.div
          style={{
            ...useSpring({
              from: { opacity: 0, scale: 0.8 },
              to: { opacity: 1, scale: 1 },
              config: config.gentle,
            }),
          }}
        >
          <div className="w-12 h-12 border-4 border-sky-500/20 border-t-sky-500 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400 text-lg">Loading your dashboard...</p>
        </animated.div>
      </div>
    </div>
  );
}

// Simple loading fallback for sections
function SectionFallback() {
  return (
    <div className="animate-pulse">
      <div className="h-48 bg-white/5 rounded-2xl" />
    </div>
  );
}

export default function DashboardPage() {
  const [sidebarOpen, setSidebarOpen] = React.useState(true);

  return (
    <div className="min-h-screen bg-[#0a0a1a] flex">
      {/* Sidebar loaded immediately (needed for layout) */}
      <Sidebar3D isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      
      {/* Main Content */}
      <div className={`flex-1 flex flex-col transition-all duration-300 ${sidebarOpen ? 'ml-72' : 'ml-0'}`}>
        {/* Top Bar */}
        <TopBar />
        
        {/* Dashboard Content */}
        <main className="flex-1 p-6 overflow-auto">
          <div className="max-w-7xl mx-auto space-y-6">
            {/* Header */}
            <div className="relative z-10">
              <h1 className="text-2xl font-bold text-white">Dashboard</h1>
              <p className="text-slate-400">Overview of your financial health</p>
            </div>

            {/* KPI Cards - Lazy loaded */}
            <Suspense fallback={<SectionFallback />}>
              <KpiCards />
            </Suspense>

            {/* Charts & GST Widget */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2">
                <Suspense fallback={<SectionFallback />}>
                  <ChartSection />
                </Suspense>
              </div>
              <div className="lg:col-span-1">
                <Suspense fallback={<SectionFallback />}>
                  <GstWidget />
                </Suspense>
              </div>
            </div>

            {/* Quick Actions & Recent Activity */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-1">
                <Suspense fallback={<SectionFallback />}>
                  <QuickActions />
                </Suspense>
              </div>
              <div className="lg:col-span-2">
                <RecentActivity />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function RecentActivity() {
  const activities = [
    { type: 'invoice', description: 'Sales Invoice INV-2026-001 created', amount: '₹45,000', time: '2 hours ago', status: 'success' },
    { type: 'payment', description: 'Payment received from ABC Corp', amount: '₹1,20,000', time: '4 hours ago', status: 'success' },
    { type: 'purchase', description: 'Purchase order PO-2026-045 placed', amount: '₹23,500', time: '6 hours ago', status: 'pending' },
    { type: 'expense', description: 'Office rent expense recorded', amount: '₹15,000', time: '8 hours ago', status: 'success' },
    { type: 'journal', description: 'Journal entry JV-2026-012 posted', amount: '₹50,000', time: '1 day ago', status: 'success' },
  ];

  return (
    <div className="p-6 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold text-white">Recent Activity</h3>
          <p className="text-slate-400 text-sm">Latest transactions and events</p>
        </div>
      </div>

      <div className="space-y-3">
        {activities.map((item, index) => (
          <div
            key={index}
            className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5 hover:border-white/10 transition-all"
          >
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                item.status === 'success' ? 'bg-emerald-500/10' : 'bg-sky-500/10'
              }`}>
                <div className={`w-2 h-2 rounded-full ${
                  item.status === 'success' ? 'bg-emerald-400' : 'bg-sky-400'
                }`} />
              </div>
              <div>
                <p className="text-white text-sm font-medium">{item.description}</p>
                <p className="text-slate-400 text-xs">{item.time}</p>
              </div>
            </div>
            <div className="text-right">
              <p className={`text-sm font-medium ${
                item.status === 'success' ? 'text-emerald-400' : 'text-sky-400'
              }`}>
                {item.amount}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
