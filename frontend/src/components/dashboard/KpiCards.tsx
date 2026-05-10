'use client';

import React, { useState } from 'react';
import { useSpring, animated, config } from '@react-spring/web';
import { Calculator, ArrowUpRight, ArrowDownRight, Wallet, PiggyBank, Loader2 } from 'lucide-react';
import { useDashboardStats } from '@/hooks/useDashboardData';

interface KPICard {
  title: string;
  value: string;
  change: string;
  isPositive: boolean;
  icon: typeof Calculator;
  color: string;
  gradient: string;
}

// Animated counter with spring
function AnimatedCounter({ target, className }: { target: number; className?: string }) {
  const { number } = useSpring({
    from: { number: 0 },
    to: { number: target },
    config: { ...config.gentle, tension: 120, friction: 20, duration: 2000 },
  });

  return (
    <animated.span className={className}>
      {number.to(n => {
        const current = Math.floor(n);
        // Format to Indian currency format
        const str = current.toString();
        if (str.length <= 3) return `₹${str}`;
        
        let lastThree = str.substring(str.length - 3);
        let otherNumbers = str.substring(0, str.length - 3);
        if (otherNumbers.length > 0) {
          lastThree = ',' + lastThree;
        }
        const formatted = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + lastThree;
        return `₹${formatted}`;
      })}
    </animated.span>
  );
}

// Single KPI Card with spring physics
function KpiCard({ card, index }: { card: KPICard; index: number }) {
  const [isHovered, setIsHovered] = useState(false);

  // Card entrance spring
  const { opacity, y, scale } = useSpring({
    from: { opacity: 0, y: 30, scale: 0.95 },
    to: { opacity: 1, y: 0, scale: 1 },
    config: { ...config.wobbly, tension: 150, friction: 18 },
    delay: index * 100,
  });

  // Hover spring
  const { cardY, cardScale, glowOpacity } = useSpring({
    cardY: isHovered ? -6 : 0,
    cardScale: isHovered ? 1.02 : 1,
    glowOpacity: isHovered ? 1 : 0,
    config: { ...config.gentle, tension: 300, friction: 15 },
  });

  return (
    <animated.div
      style={{ opacity, y, scale }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <animated.div
        style={{
          y: cardY,
          scale: cardScale,
        }}
        className="relative p-6 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm cursor-pointer"
      >
        {/* Glow effect */}
        <animated.div
          style={{ opacity: glowOpacity }}
          className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${card.color} transition-opacity duration-300`}
        />
        
        <div className="relative z-10">
          <div className="flex items-center justify-between mb-4">
            <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${card.color} flex items-center justify-center group-hover:scale-110 transition-transform duration-300`}>
              <card.icon className="w-5 h-5 text-sky-400" />
            </div>
            <div className={`flex items-center gap-1 text-xs font-medium ${card.isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
              {card.isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
              {card.change}
            </div>
          </div>
          
          <p className="text-slate-400 text-sm mb-1">{card.title}</p>
          <AnimatedCounter target={parseInt(card.value.replace(/[^\d]/g, ''))} className="text-2xl font-bold text-white" />
        </div>
      </animated.div>
    </animated.div>
  );
}

export default function KpiCards() {
  const { data: stats, isLoading } = useDashboardStats();

  // Demo data while loading or if no data
  const kpiData: KPICard[] = stats ? [
    {
      title: 'Total Revenue',
      value: `₹${stats.totalRevenue.toLocaleString()}`,
      change: `${stats.revenueChange > 0 ? '+' : ''}${stats.revenueChange}%`,
      isPositive: stats.revenueChange > 0,
      icon: Wallet,
      color: 'from-sky-500/20 to-teal-600/10',
      gradient: 'from-sky-400 to-teal-400',
    },
    {
      title: 'Outstanding Payables',
      value: `₹${stats.outstandingPayables.toLocaleString()}`,
      change: `${stats.payablesChange > 0 ? '+' : ''}${stats.payablesChange}%`,
      isPositive: stats.payablesChange < 0,
      icon: ArrowDownRight,
      color: 'from-red-500/20 to-red-600/10',
      gradient: 'from-red-400 to-red-500',
    },
    {
      title: 'GST Payable',
      value: `₹${stats.gstPayable.toLocaleString()}`,
      change: `${stats.gstChange > 0 ? '+' : ''}${stats.gstChange}%`,
      isPositive: stats.gstChange < 0,
      icon: PiggyBank,
      color: 'from-cyan-500/20 to-teal-600/10',
      gradient: 'from-cyan-400 to-teal-400',
    },
    {
      title: 'Bank Balance',
      value: `₹${stats.bankBalance.toLocaleString()}`,
      change: `${stats.bankChange > 0 ? '+' : ''}${stats.bankChange}%`,
      isPositive: stats.bankChange > 0,
      icon: Wallet,
      color: 'from-blue-500/20 to-blue-600/10',
      gradient: 'from-blue-400 to-blue-500',
    },
  ] : [
    // Fallback data
    {
      title: 'Total Revenue',
      value: '₹1,24,56,789',
      change: '+12.5%',
      isPositive: true,
      icon: Wallet,
      color: 'from-sky-500/20 to-teal-600/10',
      gradient: 'from-sky-400 to-teal-400',
    },
    {
      title: 'Outstanding Payables',
      value: '₹45,23,100',
      change: '+3.2%',
      isPositive: false,
      icon: ArrowDownRight,
      color: 'from-red-500/20 to-red-600/10',
      gradient: 'from-red-400 to-red-500',
    },
    {
      title: 'GST Payable',
      value: '₹12,34,000',
      change: '-5.1%',
      isPositive: true,
      icon: PiggyBank,
      color: 'from-cyan-500/20 to-teal-600/10',
      gradient: 'from-cyan-400 to-teal-400',
    },
    {
      title: 'Bank Balance',
      value: '₹67,89,000',
      change: '+8.7%',
      isPositive: true,
      icon: Wallet,
      color: 'from-blue-500/20 to-blue-600/10',
      gradient: 'from-blue-400 to-blue-500',
    },
  ];

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, index) => (
          <div key={index} className="p-6 rounded-2xl bg-white/5 border border-white/10 animate-pulse">
            <div className="w-10 h-10 rounded-xl bg-white/10 mb-4" />
            <div className="h-4 bg-white/10 rounded w-3/4 mb-2" />
            <div className="h-6 bg-white/10 rounded w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {kpiData.map((card, index) => (
        <KpiCard key={index} card={card} index={index} />
      ))}
    </div>
  );
}
