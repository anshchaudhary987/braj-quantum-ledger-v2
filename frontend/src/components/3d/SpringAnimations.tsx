'use client';

import React from 'react';
import { useSpring, animated, config } from '@react-spring/web';

interface SpringFadeInProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  distance?: number;
}

export function SpringFadeIn({ 
  children, 
  delay = 0, 
  className = '',
  direction = 'up',
  distance = 30 
}: SpringFadeInProps) {
  const getTransform = () => {
    switch (direction) {
      case 'up': return `translateY(${distance}px)`;
      case 'down': return `translateY(-${distance}px)`;
      case 'left': return `translateX(${distance}px)`;
      case 'right': return `translateX(-${distance}px)`;
    }
  };

  const springProps = useSpring({
    from: { opacity: 0, transform: getTransform() },
    to: { opacity: 1, transform: 'translate(0px)' },
    config: { ...config.wobbly, friction: 20, tension: 120 },
    delay,
  });

  return (
    <animated.div style={springProps} className={className}>
      {children}
    </animated.div>
  );
}

interface SpringScaleProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

export function SpringScale({ children, className = '', onClick }: SpringScaleProps) {
  const [springProps, api] = useSpring(() => ({
    scale: 1,
    config: { ...config.gentle, tension: 300, friction: 10 },
  }));

  const handleMouseDown = () => {
    api.start({ scale: 0.95 });
  };

  const handleMouseUp = () => {
    api.start({ scale: 1 });
  };

  return (
    <animated.div
      style={{ scale: springProps.scale }}
      className={className}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={onClick}
    >
      {children}
    </animated.div>
  );
}

interface SpringBounceProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}

export function SpringBounce({ children, className = '', delay = 0 }: SpringBounceProps) {
  const springProps = useSpring({
    from: { transform: 'scale(0)' },
    to: { transform: 'scale(1)' },
    config: { ...config.wobbly, tension: 300, friction: 10 },
    delay,
  });

  return (
    <animated.div style={springProps} className={className}>
      {children}
    </animated.div>
  );
}

interface SpringHoverProps {
  children: React.ReactNode;
  className?: string;
}

export function SpringHover({ children, className = '' }: SpringHoverProps) {
  const [springProps, api] = useSpring(() => ({
    y: 0,
    config: config.gentle,
  }));

  const handleMouseEnter = () => {
    api.start({ y: -4 });
  };

  const handleMouseLeave = () => {
    api.start({ y: 0 });
  };

  return (
    <animated.div
      style={{ y: springProps.y }}
      className={className}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </animated.div>
  );
}

// Ripple effect for clicks
interface RippleButtonProps {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

export function RippleButton({ children, className = '', onClick }: RippleButtonProps) {
  const [ripples, setRipples] = React.useState<{ x: number; y: number; id: number }[]>([]);
  const [springProps, api] = useSpring(() => ({
    scale: 1,
    config: config.gentle,
  }));

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const id = Date.now();
    
    setRipples(prev => [...prev, { x, y, id }]);
    
    setTimeout(() => {
      setRipples(prev => prev.filter(r => r.id !== id));
    }, 600);

    onClick?.();
  };

  return (
    <animated.button
      style={{ scale: springProps.scale }}
      className={`relative overflow-hidden ${className}`}
      onClick={handleClick}
      onMouseDown={() => api.start({ scale: 0.95 })}
      onMouseUp={() => api.start({ scale: 1 })}
    >
      {children}
      {ripples.map(ripple => (
        <span
          key={ripple.id}
          className="absolute rounded-full bg-white/30 animate-ping"
          style={{
            left: ripple.x - 10,
            top: ripple.y - 10,
            width: 20,
            height: 20,
          }}
        />
      ))}
    </animated.button>
  );
}

interface ParallaxProps {
  children: React.ReactNode;
  className?: string;
  factor?: number;
}

export function ParallaxSpring({ children, className = '', factor = 0.05 }: ParallaxProps) {
  const [springProps, api] = useSpring(() => ({
    x: 0,
    y: 0,
    config: { mass: 1, tension: 170, friction: 26 },
  }));

  React.useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const x = (window.innerWidth / 2 - e.clientX) * factor;
      const y = (window.innerHeight / 2 - e.clientY) * factor;
      api.start({ x, y });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, [api, factor]);

  return (
    <animated.div
      style={{
        transform: springProps.x.to(
          (x) => `translate3d(${x}px, ${springProps.y.get()}px, 0)`
        ),
      }}
      className={className}
    >
      {children}
    </animated.div>
  );
}
