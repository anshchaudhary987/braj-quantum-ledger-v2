'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useSpring, animated, config } from '@react-spring/web';
import { useRouter } from 'next/navigation';
import { Shield, Lock, FileCheck, TrendingUp, ArrowRight, Play, ChevronDown } from 'lucide-react';
import { TextScramble } from '@/components/3d/ImmersiveScene';

function SpringButton({ 
  children, 
  onClick, 
  className = ''
}: { 
  children: React.ReactNode; 
  onClick?: () => void;
  className?: string;
}) {
  const [{ scale }, api] = useSpring(() => ({
    scale: 1,
    config: { ...config.wobbly, tension: 400, friction: 15 },
  }));

  return (
    <animated.button
      style={{ scale }}
      onClick={onClick}
      onMouseDown={() => api.start({ scale: 0.95 })}
      onMouseUp={() => api.start({ scale: 1 })}
      onMouseLeave={() => api.start({ scale: 1 })}
      className={`cursor-pointer ${className}`}
    >
      {children}
    </animated.button>
  );
}

function SpringBadge({ icon: Icon, text }: { icon: typeof Shield; text: string }) {
  const [isHovered, setIsHovered] = useState(false);

  const { scale } = useSpring({
    scale: isHovered ? 1.05 : 1,
    config: { ...config.wobbly, tension: 300, friction: 20 },
  });

  return (
    <animated.div
      style={{ scale }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/5 border border-white/10 backdrop-blur-sm hover:bg-white/10 hover:border-sky-500/30 transition-all duration-300 cursor-pointer"
    >
      <Icon className="w-4 h-4 text-sky-400" />
      <span className="text-sm text-slate-300 font-medium">{text}</span>
    </animated.div>
  );
}

export default function HeroSection() {
  const router = useRouter();

  const scrollToFeatures = () => {
    const featuresSection = document.getElementById('features');
    if (featuresSection) {
      featuresSection.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const titleSpring = useSpring({
    from: { opacity: 0, transform: 'translateY(50px) scale(0.8)' },
    to: { opacity: 1, transform: 'translateY(0px) scale(1)' },
    config: { ...config.wobbly, tension: 150, friction: 15 },
  });

  const subtitleSpring = useSpring({
    from: { opacity: 0, transform: 'translateY(30px)' },
    to: { opacity: 1, transform: 'translateY(0px)' },
    config: { ...config.gentle, tension: 120, friction: 20 },
    delay: 300,
  });

  const descSpring = useSpring({
    from: { opacity: 0, transform: 'translateY(20px)' },
    to: { opacity: 1, transform: 'translateY(0px)' },
    config: config.slow,
    delay: 500,
  });

  const buttonSpring = useSpring({
    from: { opacity: 0, transform: 'translateY(30px) scale(0.9)' },
    to: { opacity: 1, transform: 'translateY(0px) scale(1)' },
    config: { ...config.wobbly, tension: 200, friction: 18 },
    delay: 700,
  });

  const badgeSpring = useSpring({
    from: { opacity: 0, transform: 'translateY(20px)' },
    to: { opacity: 1, transform: 'translateY(0px)' },
    config: config.gentle,
    delay: 900,
  });

  const badges = [
    { icon: Shield, text: '256-bit Encrypted' },
    { icon: FileCheck, text: 'GST Ready' },
    { icon: Lock, text: 'RBI Compliant' },
    { icon: TrendingUp, text: 'AI Powered' },
  ];

  return (
    <section className="relative min-h-[100vh] flex flex-col items-center justify-center text-center px-4 py-20 overflow-hidden">
      <div className="absolute inset-0 bg-black/40 z-0" />
      
      <div className="absolute inset-0 overflow-hidden pointer-events-none z-10">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-sky-500/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute top-1/3 right-1/4 w-72 h-72 bg-violet-500/10 rounded-full blur-3xl animate-pulse delay-1000" />
        <div className="absolute bottom-1/4 left-1/3 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl animate-pulse delay-2000" />
      </div>

      <div className="relative z-20 max-w-5xl mx-auto">
        <animated.div style={subtitleSpring}>
          <div className="inline-flex items-center gap-2 px-6 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/20 mb-8 shadow-lg shadow-sky-500/10">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-medium text-slate-300">India's Most Powerful Accounting Engine</span>
          </div>
        </animated.div>

        <animated.h1
          style={titleSpring}
          className="text-6xl md:text-8xl lg:text-9xl font-bold mb-8 tracking-tighter leading-none"
        >
          <span className="bg-gradient-to-r from-sky-300 via-cyan-400 to-teal-300 bg-clip-text text-transparent drop-shadow-lg">
            <TextScramble text="GLM Ledger" />
          </span>
        </animated.h1>

        <animated.p
          style={descSpring}
          className="text-xl md:text-3xl text-slate-300 mb-6 max-w-4xl mx-auto leading-relaxed font-light"
        >
          The next-generation accounting platform designed for Indian businesses.
          <span className="block mt-2 bg-gradient-to-r from-sky-400 to-teal-400 bg-clip-text text-transparent font-semibold">
            GST-ready, RBI compliant, and built for scale.
          </span>
        </animated.p>

        <animated.p
          style={descSpring}
          className="text-lg text-slate-400 mb-12 max-w-2xl mx-auto"
        >
          Double-entry bookkeeping that your chartered accountant will love.
        </animated.p>

        <animated.div
          style={buttonSpring}
          className="flex flex-col sm:flex-row gap-4 justify-center mb-10"
        >
          <SpringButton
            onClick={() => router.push('/register')}
            className="bg-gradient-to-r from-sky-500 to-teal-500 hover:from-sky-600 hover:to-teal-600 text-white px-10 py-7 text-lg rounded-full shadow-lg shadow-sky-500/25 hover:shadow-sky-500/50 transition-all duration-300 group font-semibold inline-flex items-center justify-center"
          >
            <span className="flex items-center">
              Start Free Trial
              <ArrowRight className="ml-2 w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </span>
          </SpringButton>
          
          <SpringButton
            onClick={() => router.push('/login')}
            className="border-white/30 text-white hover:bg-white/10 px-10 py-7 text-lg rounded-full backdrop-blur-sm font-semibold inline-flex items-center justify-center"
          >
            Log In
          </SpringButton>
        </animated.div>

        <animated.div
          style={useSpring({
            from: { opacity: 0 },
            to: { opacity: 1 },
            config: config.slow,
            delay: 1000,
          })}
          className="mb-16"
        >
          <SpringButton
            onClick={() => router.push('/dashboard')}
            className="border-sky-500/30 text-sky-400 hover:bg-sky-500/10 px-8 py-3 rounded-full backdrop-blur-sm text-sm font-medium inline-flex items-center justify-center"
          >
            <Play className="mr-2 w-4 h-4" />
            Try Dashboard
          </SpringButton>
        </animated.div>

        <animated.div
          style={badgeSpring}
          className="flex flex-wrap justify-center gap-4"
        >
          {badges.map((badge, index) => (
            <SpringBadge key={index} icon={badge.icon} text={badge.text} />
          ))}
        </animated.div>
      </div>

      <animated.div
        style={useSpring({
          from: { opacity: 0 },
          to: { opacity: 1 },
          config: config.slow,
          delay: 1200,
        })}
        className="absolute bottom-10 left-1/2 -translate-x-1/2 cursor-pointer z-20"
        onClick={scrollToFeatures}
      >
        <motion.div
          animate={{ y: [0, 10, 0] }}
          transition={{ duration: 1.5, repeat: Infinity }}
          className="flex flex-col items-center gap-2 text-slate-400 hover:text-sky-400 transition-colors"
        >
          <span className="text-sm font-medium">Explore More</span>
          <ChevronDown className="w-6 h-6" />
        </motion.div>
      </animated.div>
    </section>
  );
}
