'use client';

import React, { useState, useEffect } from 'react';
import { useSpring, animated, config, useInView } from '@react-spring/web';
import { Building2, Landmark, Users, Award } from 'lucide-react';

const stats = [
  { icon: Building2, value: 50000, suffix: '+', label: 'Businesses Trust Us' },
  { icon: Landmark, value: 12, suffix: 'T+', prefix: '₹', label: 'Transactions Processed' },
  { icon: Users, value: 2000000, suffix: '+', label: 'Active Users' },
  { icon: Award, value: 99.9, suffix: '%', label: 'Uptime Guaranteed' },
];

// Animated counter with spring physics
function SpringCounter({ target, suffix = '', prefix = '', inView }: { target: number; suffix?: string; prefix?: string; inView: boolean }) {
  const { number } = useSpring({
    from: { number: 0 },
    to: { number: inView ? target : 0 },
    config: { ...config.gentle, tension: 100, friction: 20 },
    delay: 200,
  });

  return (
    <animated.span>
      {number.to(n => {
        let display: string;
        if (target >= 1000000) {
          display = (n / 1000000).toFixed(0) + 'M';
        } else if (target >= 1000) {
          display = (n / 1000).toFixed(0) + 'K';
        } else {
          display = n.toFixed(n % 1 !== 0 ? 1 : 0);
        }
        return `${prefix || ''}${display}${suffix}`;
      })}
    </animated.span>
  );
}

// Stat card with spring hover effect
function StatCard({ stat, index, inView }: { stat: typeof stats[0]; index: number; inView: boolean }) {
  const [isHovered, setIsHovered] = useState(false);

  const { scale, y, glowOpacity } = useSpring({
    scale: isHovered ? 1.05 : 1,
    y: isHovered ? -6 : 0,
    glowOpacity: isHovered ? 1 : 0,
    config: { ...config.wobbly, tension: 300, friction: 20 },
  });

  const { opacity, translateY } = useSpring({
    from: { opacity: 0, translateY: 40 },
    to: { opacity: inView ? 1 : 0, translateY: inView ? 0 : 40 },
    config: { ...config.gentle, tension: 120, friction: 20 },
    delay: index * 150,
  });

  return (
    <animated.div
      style={{ opacity, y: translateY, scale }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="text-center p-8 relative"
    >
      {/* Glow effect */}
      <animated.div
        style={{ opacity: glowOpacity }}
        className="absolute inset-0 rounded-3xl bg-gradient-to-br from-sky-500/10 to-teal-500/10 blur-xl"
      />
      
      <div className="relative z-10">
        <animated.div
          style={{ scale }}
          className="w-20 h-20 rounded-3xl bg-gradient-to-br from-sky-500/10 to-teal-500/10 border border-sky-500/20 flex items-center justify-center mx-auto mb-6 hover:from-sky-500/20 hover:to-teal-500/20 transition-all duration-300"
        >
          <stat.icon className="w-10 h-10 text-sky-400" />
        </animated.div>
        
        <div className="text-4xl md:text-5xl font-bold text-white mb-2">
          <SpringCounter target={stat.value} suffix={stat.suffix} prefix={stat.prefix} inView={inView} />
        </div>
        <div className="text-slate-400 text-lg">
          {stat.label}
        </div>
      </div>
    </animated.div>
  );
}

export default function TrustSection() {
  const ref = React.useRef(null);
  const inView = useInView(ref, { once: true, margin: '-100px' });

  const sectionSpring = useSpring({
    from: { opacity: 0, transform: 'translateY(40px)' },
    to: { opacity: inView ? 1 : 0, transform: inView ? 'translateY(0px)' : 'translateY(40px)' },
    config: config.gentle,
  });

  return (
    <section ref={ref} className="relative py-32 px-4 bg-gradient-to-b from-[#0F172A] via-[#0F172A] to-[#1E293B]">
      <div className="absolute inset-0 bg-[url('/images/grid.svg')] opacity-5" />
      
      <div className="relative max-w-7xl mx-auto">
        <animated.div
          style={sectionSpring}
          className="text-center mb-20"
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-sky-500/10 border border-sky-500/20 mb-6">
            <Award className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-medium text-sky-400">Trusted by Industry Leaders</span>
          </div>
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6">
            <span className="bg-gradient-to-r from-sky-300 via-cyan-400 to-teal-300 bg-clip-text text-transparent">
              Trusted by Businesses Across India
            </span>
          </h2>
          <p className="text-slate-400 text-xl max-w-2xl mx-auto">
            From startups to enterprises, GLM Ledger powers financial operations nationwide
          </p>
        </animated.div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {stats.map((stat, index) => (
            <StatCard key={index} stat={stat} index={index} inView={inView} />
          ))}
        </div>
      </div>
    </section>
  );
}
