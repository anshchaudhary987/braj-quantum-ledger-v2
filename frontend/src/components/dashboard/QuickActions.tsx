'use client';

import React, { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useSpring, animated, config } from '@react-spring/web';
import { Plus, Receipt, ArrowDownLeft, ArrowUpRight, FileText } from 'lucide-react';

const actions = [
  { icon: Receipt, label: 'Create Invoice', color: 'from-sky-500 to-teal-500' },
  { icon: ArrowDownLeft, label: 'Record Payment', color: 'from-emerald-500 to-teal-500' },
  { icon: ArrowUpRight, label: 'Make Payment', color: 'from-red-500 to-pink-500' },
  { icon: FileText, label: 'View Reports', color: 'from-blue-500 to-indigo-500' },
];

// Magnetic button with physics-based attraction
function MagneticQuickAction({ 
  action, 
  index 
}: { 
  action: typeof actions[0]; 
  index: number;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);

  const [{ x, y }, api] = useSpring(() => ({
    x: 0,
    y: 0,
    config: { ...config.wobbly, tension: 150, friction: 15 },
  }));

  const [{ rotateX, rotateY, scale }, api3d] = useSpring(() => ({
    rotateX: 0,
    rotateY: 0,
    scale: 1,
    config: { ...config.wobbly, tension: 200, friction: 20 },
  }));

  // Handle mouse movement for magnetic + tilt effect
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (!ref.current) return;
    
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Magnetic effect
    const magneticStrength = 0.3;
    const newX = (e.clientX - centerX) * magneticStrength;
    const newY = (e.clientY - centerY) * magneticStrength;

    // Tilt effect
    const tiltMax = 10;
    const newRotateX = ((e.clientY - centerY) / (rect.height / 2)) * -tiltMax;
    const newRotateY = ((e.clientX - centerX) / (rect.width / 2)) * tiltMax;

    api.start({ x: newX, y: newY });
    api3d.start({ 
      rotateX: newRotateX, 
      rotateY: newRotateY, 
      scale: 1.05 
    });
  }, [api, api3d]);

  const handleMouseLeave = () => {
    setIsHovered(false);
    setIsPressed(false);
    api.start({ x: 0, y: 0 });
    api3d.start({ rotateX: 0, rotateY: 0, scale: 1 });
  };

  const handleMouseDown = () => {
    setIsPressed(true);
    api3d.start({ scale: 0.95 });
  };

  const handleMouseUp = () => {
    setIsPressed(false);
    api3d.start({ scale: 1.05 });
  };

  // Icon spring
  const { iconScale } = useSpring({
    iconScale: isHovered ? 1.2 : 1,
    config: config.wobbly,
  });

  return (
    <animated.button
      ref={ref}
      style={{
        x,
        y,
        rotateX,
        rotateY,
        scale,
        transformStyle: 'preserve-3d',
      }}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      className="group relative p-4 rounded-xl bg-white/5 border border-white/10 hover:border-white/20 transition-all duration-300 text-left w-full overflow-hidden"
    >
      {/* Spotlight effect */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-br from-sky-500/5 to-teal-500/5" />
      </div>

      <animated.div
        style={{
          scale: iconScale,
          display: 'inline-block',
        }}
        className={`w-10 h-10 rounded-xl bg-gradient-to-br ${action.color} flex items-center justify-center mb-3`}
      >
        <action.icon className="w-5 h-5 text-white" />
      </animated.div>
      
      <p className="text-white text-sm font-medium relative z-10">{action.label}</p>
    </animated.button>
  );
}

export default function QuickActions() {
  // Container entrance spring
  const { opacity, y } = useSpring({
    from: { opacity: 0, y: 30 },
    to: { opacity: 1, y: 0 },
    config: { ...config.gentle, tension: 120, friction: 20 },
    delay: 600,
  });

  return (
    <animated.div
      style={{ opacity, y }}
      className="p-6 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm"
    >
      <h3 className="text-lg font-semibold text-white mb-4">Quick Actions</h3>
      
      <div className="grid grid-cols-2 gap-3">
        {actions.map((action, index) => (
          <MagneticQuickAction key={index} action={action} index={index} />
        ))}
      </div>

      {/* Magnetic More Actions button */}
      <MagneticMoreButton />
    </animated.div>
  );
}

function MagneticMoreButton() {
  const ref = useRef<HTMLButtonElement>(null);
  
  const [{ x, y }, api] = useSpring(() => ({
    x: 0,
    y: 0,
    config: { ...config.wobbly, tension: 150, friction: 15 },
  }));

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (!ref.current) return;
    
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const magneticStrength = 0.2;
    const newX = (e.clientX - centerX) * magneticStrength;
    const newY = (e.clientY - centerY) * magneticStrength;

    api.start({ x: newX, y: newY });
  }, [api]);

  const handleMouseLeave = () => {
    api.start({ x: 0, y: 0 });
  };

  return (
    <animated.button
      ref={ref}
      style={{ x, y }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="w-full mt-4 p-3 rounded-xl bg-gradient-to-r from-sky-500/20 to-teal-500/20 border border-sky-500/20 text-sky-400 text-sm font-medium hover:from-sky-500/30 hover:to-teal-500/30 transition-all flex items-center justify-center gap-2"
    >
      <Plus className="w-4 h-4" />
      More Actions
    </animated.button>
  );
}
