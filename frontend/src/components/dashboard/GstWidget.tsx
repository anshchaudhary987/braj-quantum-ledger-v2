'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useSpring, animated, config } from '@react-spring/web';
import { Check, X, Clock, AlertTriangle, Loader2 } from 'lucide-react';
import { useGSTStatus } from '@/hooks/useDashboardData';

// GST Status indicator with spring animation
function StatusIndicator({ status, isHovered }: { status: 'filed' | 'pending' | 'overdue'; isHovered: boolean }) {
  const { scale, rotate } = useSpring({
    scale: isHovered ? 1.2 : 1,
    rotate: isHovered ? -10 : 0,
    config: { ...config.wobbly, tension: 400, friction: 15 },
  });

  const getColor = () => {
    switch (status) {
      case 'filed': return 'bg-emerald-500/10 text-emerald-400';
      case 'pending': return 'bg-sky-500/10 text-sky-400';
      case 'overdue': return 'bg-red-500/10 text-red-400';
    }
  };

  const getIcon = () => {
    switch (status) {
      case 'filed': return <Check className="w-4 h-4" />;
      case 'pending': return <Clock className="w-4 h-4" />;
      case 'overdue': return <AlertTriangle className="w-4 h-4" />;
    }
  };

  return (
    <animated.div
      style={{ scale, rotate }}
      className={`w-8 h-8 rounded-lg flex items-center justify-center ${getColor()}`}
    >
      {getIcon()}
    </animated.div>
  );
}

export default function GstWidget() {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  
  const { data: gstStatus, isLoading } = useGSTStatus();

  // Widget entrance spring
  const { opacity, y } = useSpring({
    from: { opacity: 0, y: 30 },
    to: { opacity: 1, y: 0 },
    config: { ...config.wobbly, tension: 150, friction: 18 },
    delay: 400,
  });

  // Action alert spring
  const { alertScale } = useSpring({
    scale: hoveredIndex === -1 ? 1.02 : 1,
    config: config.gentle,
  });

  if (isLoading || !gstStatus) {
    return (
      <div className="p-6 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm">
        <div className="animate-pulse">
          <div className="h-6 bg-white/10 rounded w-48 mb-4" />
          <div className="h-4 bg-white/10 rounded w-32 mb-6" />
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-12 bg-white/5 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const { returns, complianceScore, actionRequired } = gstStatus;

  return (
    <animated.div
      style={{ opacity, y }}
      onMouseEnter={() => setHoveredIndex(-1)}
      onMouseLeave={() => setHoveredIndex(null)}
      className="p-6 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm hover:border-white/20 transition-all duration-300"
    >
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold text-white">GST Compliance</h3>
          <p className="text-slate-400 text-sm">Return filing status</p>
        </div>
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500/20 to-teal-600/10 border border-sky-500/20 flex items-center justify-center">
          <span className="text-sky-400 font-bold text-lg">₹</span>
        </div>
      </div>

      {/* Compliance score */}
      <div className="mb-4 p-3 rounded-xl bg-white/5 border border-white/10">
        <div className="flex items-center justify-between">
          <span className="text-white text-sm">Compliance Score</span>
          <span className="text-sky-400 font-semibold">{complianceScore}%</span>
        </div>
        <div className="mt-2 h-2 bg-white/10 rounded-full overflow-hidden">
          <animated.div
            style={{
              width: useSpring({
                from: { width: '0%' },
                to: { width: `${complianceScore}%` },
                config: { ...config.gentle, duration: 1000 },
              }).width,
            }}
            className="h-full bg-gradient-to-r from-sky-500 to-teal-500 rounded-full"
          />
        </div>
      </div>

      <div className="space-y-3">
        {returns.map((item, index) => (
          <motion.div
            key={index}
            whileHover={{ x: 4 }}
            onMouseEnter={() => setHoveredIndex(index)}
            onMouseLeave={() => setHoveredIndex(null)}
            className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5 hover:border-white/10 transition-all cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <StatusIndicator status={item.status} isHovered={hoveredIndex === index} />
              <div>
                <p className="text-white text-sm font-medium">{item.form}</p>
                <p className="text-slate-400 text-xs">{item.period}</p>
              </div>
            </div>
            <div className="text-right">
              <p className={`text-xs font-medium ${
                item.status === 'filed' ? 'text-emerald-400' :
                item.status === 'pending' ? 'text-sky-400' :
                'text-red-400'
              }`}>
                {item.status === 'filed' ? 'Filed' : 
                 item.status === 'pending' ? 'Due ' + item.dueDate : 
                 'Overdue'}
              </p>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Action alert with spring */}
      {actionRequired && (
        <animated.div
          style={{
            scale: alertScale,
            config: config.wobbly,
          }}
          className="mt-6 p-4 rounded-xl bg-gradient-to-r from-sky-500/10 to-teal-500/10 border border-sky-500/20"
        >
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-sky-400" />
            <div>
              <p className="text-sky-300 text-sm font-medium">Action Required</p>
              <p className="text-sky-400/80 text-xs">{actionRequired}</p>
            </div>
          </div>
        </animated.div>
      )}
    </animated.div>
  );
}
