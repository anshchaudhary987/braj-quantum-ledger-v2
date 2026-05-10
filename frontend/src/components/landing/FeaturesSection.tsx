'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useSpring, animated, config } from '@react-spring/web';
import { Calculator, FileText, BarChart3, Users, Wallet, TrendingUp, ArrowUpRight } from 'lucide-react';

const features = [
  {
    icon: Calculator,
    title: 'Double-Entry Accounting',
    description: 'Robust double-entry bookkeeping with automatic trial balance reconciliation and real-time ledger updates.',
  },
  {
    icon: FileText,
    title: 'GST Compliance',
    description: 'Automated GST return preparation with GSTR-1, GSTR-3B, and GSTR-9 filing support. E-invoicing ready.',
  },
  {
    icon: BarChart3,
    title: 'Financial Reporting',
    description: 'Generate P&L, Balance Sheet, Cash Flow, and customized reports with drill-down capabilities.',
  },
  {
    icon: Users,
    title: 'Payroll & TDS',
    description: 'Complete payroll management with TDS, PF, ESI calculations and Form 16 generation.',
  },
  {
    icon: Wallet,
    title: 'Banking & Reconciliation',
    description: 'Automatic bank statement import, smart matching engine, and real-time reconciliation.',
  },
  {
    icon: TrendingUp,
    title: 'Analytics & Budgeting',
    description: 'Scenario-based budgeting, cost center analysis, and AI-powered financial insights.',
  },
];

// Holographic card with React Spring physics
function HolographicSpringCard({ feature, index }: { feature: typeof features[0]; index: number }) {
  const [isHovered, setIsHovered] = useState(false);

  // 3D tilt spring
  const { transform, shadow } = useSpring({
    transform: isHovered
      ? 'perspective(1000px) rotateX(5deg) rotateY(5deg) scale(1.05)'
      : 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale(1)',
    shadow: isHovered
      ? '0 25px 50px -12px rgba(14,165,233, 0.25)'
      : '0 10px 15px -3px rgba(0,0,0, 0.1)',
    config: { ...config.wobbly, tension: 300, friction: 20 },
  });

  // Holographic sheen spring
  const { sheen } = useSpring({
    sheen: isHovered ? 1 : 0,
    config: config.fast,
  });

  // Icon spring
  const { iconScale } = useSpring({
    iconScale: isHovered ? 1.2 : 1,
    config: config.wobbly,
  });

  // Entrance animation
  const { opacity, y } = useSpring({
    from: { opacity: 0, y: 60 },
    to: { opacity: 1, y: 0 },
    config: { ...config.gentle, tension: 120, friction: 20 },
    delay: index * 100,
  });

  return (
    <animated.div
      style={{
        opacity,
        y,
        transform,
        boxShadow: shadow,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="group relative cursor-pointer"
    >
      <div className="relative p-8 rounded-3xl bg-white/5 border border-white/10 backdrop-blur-sm hover:bg-white/10 transition-all duration-500 hover:border-sky-500/30 h-full">
        {/* Holographic sheen effect - Spring animated */}
        <animated.div
          style={{
            opacity: sheen,
            config: config.fast,
          }}
          className="absolute inset-0 rounded-3xl bg-gradient-to-br from-sky-500/10 to-teal-500/10"
        />
        <animated.div
          style={{
            opacity: sheen,
            transform: sheen.to(v => `translateX(${v * 100}%)`),
          }}
          className="absolute inset-0 rounded-3xl bg-gradient-to-r from-transparent via-white/10 to-transparent"
        />
        
        <div className="relative z-10">
          <animated.div
            style={{ scale: iconScale }}
            className="w-14 h-14 rounded-2xl bg-gradient-to-br from-sky-500/20 to-teal-500/20 flex items-center justify-center mb-6 group-hover:from-sky-500/30 group-hover:to-teal-500/30 transition-all duration-300"
          >
            <feature.icon className="w-7 h-7 text-sky-400" />
          </animated.div>
          
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xl font-semibold text-white group-hover:text-sky-400 transition-colors">
              {feature.title}
            </h3>
            <ArrowUpRight className="w-5 h-5 text-slate-500 group-hover:text-sky-400 group-hover:translate-x-1 group-hover:-translate-y-1 transition-all opacity-0 group-hover:opacity-100" />
          </div>
          
          <p className="text-slate-400 leading-relaxed">
            {feature.description}
          </p>
        </div>
      </div>
    </animated.div>
  );
}

export default function FeaturesSection() {
  // Section entrance spring
  const sectionSpring = useSpring({
    from: { opacity: 0, transform: 'translateY(40px)' },
    to: { opacity: 1, transform: 'translateY(0px)' },
    config: config.gentle,
  });

  return (
    <section id="features" className="relative py-32 px-4 bg-gradient-to-b from-[#0F172A] via-[#1E293B] to-[#0F172A]">
      <div className="max-w-7xl mx-auto">
        <animated.div
          style={sectionSpring}
          className="text-center mb-20"
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-sky-500/10 border border-sky-500/20 mb-6">
            <TrendingUp className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-medium text-sky-400">Features</span>
          </div>
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6">
            <span className="bg-gradient-to-r from-sky-300 via-cyan-400 to-teal-300 bg-clip-text text-transparent">
              Everything You Need
            </span>
          </h2>
          <p className="text-slate-400 text-xl max-w-2xl mx-auto">
            A complete suite of accounting tools designed specifically for Indian businesses
          </p>
        </animated.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <HolographicSpringCard key={index} feature={feature} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}
