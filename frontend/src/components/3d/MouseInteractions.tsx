'use client';

import React, { useState, useCallback, useRef } from 'react';
import { useSpring, animated, config } from '@react-spring/web';

// ============================================
// CLICK RIPPLE EFFECT
// ============================================

interface Ripple {
  id: number;
  x: number;
  y: number;
  size: number;
}

export function RippleEffect({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const [ripples, setRipples] = useState<Ripple[]>([]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const id = Date.now();

    setRipples((prev) => [...prev, { id, x, y, size: 0 }]);

    // Remove ripple after animation
    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, 600);
  }, []);

  return (
    <div className={`relative overflow-hidden ${className}`} onClick={handleClick}>
      {children}
      {ripples.map((ripple) => (
        <span
          key={ripple.id}
          className="absolute rounded-full bg-sky-400/30 pointer-events-none animate-burst"
          style={{
            left: ripple.x - 10,
            top: ripple.y - 10,
            width: 20,
            height: 20,
            animation: 'burst 0.6s ease-out forwards',
          }}
        />
      ))}
      <style jsx>{`
        @keyframes burst {
          to {
            transform: scale(4);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
}

// ============================================
// MAGNETIC BUTTON EFFECT
// ============================================

export function MagneticButton({ 
  children, 
  className = '',
  strength = 0.3,
}: { 
  children: React.ReactNode; 
  className?: string;
  strength?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const [{ x, y }, api] = useSpring(() => ({
    x: 0,
    y: 0,
    config: { ...config.wobbly, tension: 150, friction: 15 },
  }));

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const deltaX = (e.clientX - centerX) * strength;
    const deltaY = (e.clientY - centerY) * strength;

    api.start({ x: deltaX, y: deltaY });
  }, [api, strength]);

  const handleMouseLeave = useCallback(() => {
    api.start({ x: 0, y: 0 });
  }, [api]);

  return (
    <animated.div
      ref={ref}
      style={{ x, y }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={className}
    >
      {children}
    </animated.div>
  );
}

// ============================================
// CURSOR TRACKING SPOTLIGHT EFFECT
// ============================================

export function SpotlightCard({ 
  children, 
  className = '',
  color = 'rgb(14, 165, 233)', // sky-500
}: { 
  children: React.ReactNode; 
  className?: string;
  color?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setMousePosition({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }, []);

  const { opacity } = useSpring({
    opacity: isHovered ? 1 : 0,
    config: config.fast,
  });

  return (
    <animated.div
      ref={ref}
      className={`relative ${className}`}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Spotlight gradient */}
      <animated.div
        style={{
          opacity,
          background: `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, ${color.replace(')', ', 0.15)')}, transparent 40%)`,
        }}
        className="absolute inset-0 pointer-events-none rounded-inherit"
      />
      {children}
    </animated.div>
  );
}

// ============================================
// MOUSE TRAIL PARTICLE SYSTEM
// ============================================

interface TrailPoint {
  id: number;
  x: number;
  y: number;
  size: number;
  opacity: number;
}

export function MouseTrail({ 
  children, 
  className = '',
  particleColor = 'rgb(14, 165, 233)',
}: { 
  children: React.ReactNode; 
  className?: string;
  particleColor?: string;
}) {
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const idRef = useRef(0);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    idRef.current += 1;

    setTrail((prev) => {
      const newPoint: TrailPoint = {
        id: idRef.current,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        size: Math.random() * 8 + 4,
        opacity: 0.6,
      };

      // Keep only last 20 points
      const newTrail = [...prev.slice(-19), newPoint];
      
      // Fade out points
      return newTrail.map((point, index) => ({
        ...point,
        opacity: Math.max(0, point.opacity - 0.02),
      }));
    });
  }, []);

  // Cleanup faded points
  React.useEffect(() => {
    const interval = setInterval(() => {
      setTrail((prev) => prev.filter((point) => point.opacity > 0));
    }, 50);
    return () => clearInterval(interval);
  }, []);

  return (
    <div 
      className={`relative ${className}`}
      onMouseMove={handleMouseMove}
    >
      {children}
      {/* Trail particles */}
      {trail.map((point) => (
        <div
          key={point.id}
          className="absolute rounded-full pointer-events-none"
          style={{
            left: point.x - point.size / 2,
            top: point.y - point.size / 2,
            width: point.size,
            height: point.size,
            backgroundColor: particleColor,
            opacity: point.opacity,
            filter: 'blur(2px)',
            transition: 'opacity 0.5s ease-out',
          }}
        />
      ))}
    </div>
  );
}

// ============================================
// MAGNETIC CURSOR ATTRACTOR
// ============================================

export function MagneticAttractor({
  children,
  className = '',
  attractRadius = 100,
  strength = 0.5,
}: {
  children: React.ReactNode;
  className?: string;
  attractRadius?: number;
  strength?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const [{ x, y, scale }, api] = useSpring(() => ({
    x: 0,
    y: 0,
    scale: 1,
    config: { ...config.wobbly, tension: 120, friction: 14 },
  }));

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const distance = Math.sqrt(
      Math.pow(e.clientX - centerX, 2) + Math.pow(e.clientY - centerY, 2)
    );

    if (distance < attractRadius) {
      const deltaX = (e.clientX - centerX) * (1 - distance / attractRadius) * strength;
      const deltaY = (e.clientY - centerY) * (1 - distance / attractRadius) * strength;
      
      api.start({ 
        x: deltaX, 
        y: deltaY,
        scale: 1.1,
      });
    } else {
      api.start({ x: 0, y: 0, scale: 1 });
    }
  }, [api, attractRadius, strength]);

  const handleMouseLeave = useCallback(() => {
    api.start({ x: 0, y: 0, scale: 1 });
  }, [api]);

  return (
    <animated.div
      ref={ref}
      style={{ x, y, scale }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={className}
    >
      {children}
    </animated.div>
  );
}

// ============================================
// TILT ON HOVER
// ============================================

export function TiltCard({
  children,
  className = '',
  maxTilt = 10,
}: {
  children: React.ReactNode;
  className?: string;
  maxTilt?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const [{ rotateX, rotateY }, api] = useSpring(() => ({
    rotateX: 0,
    rotateY: 0,
    config: { ...config.wobbly, tension: 200, friction: 20 },
  }));

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    
    const rect = ref.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    api.start({
      rotateX: (y - 0.5) * -maxTilt,
      rotateY: (x - 0.5) * maxTilt,
    });
  }, [api, maxTilt]);

  const handleMouseLeave = useCallback(() => {
    api.start({ rotateX: 0, rotateY: 0 });
  }, [api]);

  return (
    <animated.div
      ref={ref}
      style={{
        rotateX,
        rotateY,
        transformStyle: 'preserve-3d',
        perspective: 1000,
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={className}
    >
      {children}
    </animated.div>
  );
}

// ============================================
// PARALLAX MOUSE MOVEMENT
// ============================================

export function ParallaxMouse({
  children,
  className = '',
  factor = 0.05,
}: {
  children: React.ReactNode;
  className?: string;
  factor?: number;
}) {
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const x = (window.innerWidth / 2 - e.clientX) * factor;
    const y = (window.innerHeight / 2 - e.clientY) * factor;
    setMousePosition({ x, y });
  }, [factor]);

  const { x, y } = useSpring({
    x: mousePosition.x,
    y: mousePosition.y,
    config: { ...config.gentle, tension: 120, friction: 14 },
  });

  return (
    <div onMouseMove={handleMouseMove} className={className}>
      <animated.div
        style={{
          transform: x.to((xVal) => `translate3d(${xVal}px, ${y.get()}px, 0)`),
        }}
      >
        {children}
      </animated.div>
    </div>
  );
}

// ============================================
// COMBINED INTERACTIVE CARD
// ============================================

export function InteractiveCard({
  children,
  className = '',
  magneticStrength = 0.3,
  tiltMax = 10,
  spotlightColor = 'rgb(14, 165, 233)',
}: {
  children: React.ReactNode;
  className?: string;
  magneticStrength?: number;
  tiltMax?: number;
  spotlightColor?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);

  const [{ x, y, rotateX, rotateY, scale }, api] = useSpring(() => ({
    x: 0,
    y: 0,
    rotateX: 0,
    rotateY: 0,
    scale: 1,
    config: { ...config.wobbly, tension: 150, friction: 15 },
  }));

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Magnetic effect
    const magneticX = (e.clientX - centerX) * magneticStrength;
    const magneticY = (e.clientY - centerY) * magneticStrength;

    // Tilt effect
    const tiltX = ((e.clientY - centerY) / (rect.height / 2)) * -tiltMax;
    const tiltY = ((e.clientX - centerX) / (rect.width / 2)) * tiltMax;

    api.start({
      x: magneticX,
      y: magneticY,
      rotateX: tiltX,
      rotateY: tiltY,
      scale: 1.02,
    });

    // Spotlight position
    setMousePosition({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
  }, [api, magneticStrength, tiltMax]);

  const handleMouseLeave = useCallback(() => {
    api.start({
      x: 0,
      y: 0,
      rotateX: 0,
      rotateY: 0,
      scale: 1,
    });
    setIsHovered(false);
  }, [api]);

  const spotlightOpacity = useSpring({
    opacity: isHovered ? 1 : 0,
    config: config.fast,
  });

  return (
    <animated.div
      ref={ref}
      style={{
        x,
        y,
        rotateX,
        rotateY,
        scale,
        transformStyle: 'preserve-3d',
        perspective: 1000,
      }}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={handleMouseLeave}
      className={`relative overflow-hidden ${className}`}
    >
      {/* Spotlight */}
      <animated.div
        style={{
          opacity: spotlightOpacity.opacity,
          background: `radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, ${spotlightColor.replace(')', ', 0.15)')}, transparent 40%)`,
        }}
        className="absolute inset-0 pointer-events-none rounded-inherit"
      />
      {children}
    </animated.div>
  );
}
