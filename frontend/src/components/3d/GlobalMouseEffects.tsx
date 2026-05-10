'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSpring, animated, config } from '@react-spring/web';

// ============================================
// GLOBAL MOUSE TRAIL THAT WORKS ACROSS PAGES
// ============================================

interface TrailPoint {
  id: number;
  x: number;
  y: number;
  size: number;
  opacity: number;
  color: string;
}

// Custom hook for mouse trail
function useGlobalMouseTrail() {
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const idRef = useRef(0);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const now = Date.now();
      // Throttle to 50ms (20fps for the trail points)
      if (now - lastUpdateRef.current < 50) return;
      lastUpdateRef.current = now;

      idRef.current += 1;

      const colors = [
        'rgb(14, 165, 233)',  // sky-500
        'rgb(45, 212, 191)',  // teal-400
        'rgb(34, 211, 238)',  // cyan-400
        'rgb(99, 102, 241)',  // indigo-500
      ];
      
      const color = colors[Math.floor(Math.random() * colors.length)];

      setTrail((prev) => {
        const newPoint: TrailPoint = {
          id: idRef.current,
          x: e.clientX,
          y: e.clientY,
          size: Math.random() * 6 + 2,
          opacity: 0.8,
          color,
        };

        // Keep only last 15 points
        return [...prev.slice(-14), newPoint];
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    
    // Fade out points over time
    const interval = setInterval(() => {
      setTrail((prev) => 
        prev
          .map((point) => ({ ...point, opacity: point.opacity - 0.04 }))
          .filter((point) => point.opacity > 0)
      );
    }, 50);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      clearInterval(interval);
    };
  }, []);

  return trail;
}

// Global Mouse Trail Component
export function GlobalMouseTrail() {
  const trail = useGlobalMouseTrail();

  return (
    <div className="fixed inset-0 pointer-events-none z-[9999]">
      {trail.map((point) => (
        <div
          key={point.id}
          className="absolute rounded-full"
          style={{
            left: point.x - point.size / 2,
            top: point.y - point.size / 2,
            width: point.size,
            height: point.size,
            backgroundColor: point.color,
            opacity: point.opacity,
            filter: 'blur(1px)',
            transition: 'all 0.1s ease-out',
          }}
        />
      ))}
    </div>
  );
}

// ============================================
// SCROLL VELOCITY TILT EFFECT
// ============================================

export function ScrollTiltContainer({ 
  children, 
  className = '' 
}: { 
  children: React.ReactNode; 
  className?: string 
}) {
  const [scrollVelocity, setScrollVelocity] = useState(0);
  const lastScrollY = useRef(0);
  const tiltRef = useRef(0);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      const velocity = currentScrollY - lastScrollY.current;
      lastScrollY.current = currentScrollY;

      // Calculate tilt based on velocity
      const targetTilt = Math.min(Math.max(velocity * 0.1, -5), 5);
      tiltRef.current = targetTilt;

      // Reset velocity after scrolling stops
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        tiltRef.current = 0;
      }, 150);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      clearTimeout(timeout);
    };
  }, []);

  return (
    <div 
      className={`transform-gpu transition-transform duration-200 ${className}`}
      style={{
        transform: `perspective(1000px) rotateX(${scrollVelocity * 0.1}deg)`,
      }}
    >
      {children}
    </div>
  );
}

// ============================================
// CURSOR GLOW SPOTLIGHT
// ============================================

export function CursorGlow({ 
  children, 
  className = '',
  color = 'rgb(14, 165, 233)' 
}: { 
  children: React.ReactNode; 
  className?: string;
  color?: string;
}) {
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isVisible, setIsVisible] = useState(false);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setMousePosition({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }, []);

  const glowSpring = useSpring({
    from: { opacity: 0 },
    to: { opacity: isVisible ? 1 : 0 },
    config: config.fast,
  });

  return (
    <div 
      className={`relative ${className}`}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      {/* Cursor glow */}
      <animated.div
        style={{
          ...glowSpring,
          position: 'absolute',
          left: mousePosition.x - 150,
          top: mousePosition.y - 150,
          width: 300,
          height: 300,
          background: `radial-gradient(circle, ${color.replace(')', ', 0.15)')}, transparent 70%)`,
          pointerEvents: 'none',
          borderRadius: '50%',
        }}
      />
      {children}
    </div>
  );
}

// ============================================
// COMBINED DASHBOARD WRAPPER
// ============================================

export function DashboardMouseEnhancements() {
  return (
    <>
      <GlobalMouseTrail />
    </>
  );
}
