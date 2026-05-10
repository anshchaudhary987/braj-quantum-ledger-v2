'use client';

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useSpring, animated, config } from '@react-spring/web';
import { LayoutDashboard, Receipt, BarChart3, Package, FileText, Users, Settings, HelpCircle, LogOut } from 'lucide-react';
import { useRouter, usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const menuItems = [
  { icon: LayoutDashboard, label: 'Dashboard', href: '/dashboard' },
  { icon: Receipt, label: 'Vouchers', href: '/vouchers' },
  { icon: FileText, label: 'GST', href: '/gst' },
  { icon: BarChart3, label: 'Reports', href: '/reports' },
  { icon: Package, label: 'Inventory', href: '/inventory' },
  { icon: Users, label: 'Payroll', href: '/payroll' },
  { icon: Settings, label: 'Settings', href: '/settings' },
];

interface Sidebar3DProps {
  isOpen: boolean;
  onClose: () => void;
}

// Animated menu item with spring physics
function MenuItem({ item, isActive, onClick, index }: { 
  item: typeof menuItems[0]; 
  isActive: boolean; 
  onClick: () => void;
  index: number;
}) {
  const [isHovered, setIsHovered] = useState(false);

  const { x, scale, glowOpacity } = useSpring({
    x: isHovered ? 4 : 0,
    scale: isHovered ? 1.02 : 1,
    glowOpacity: isHovered ? 1 : 0,
    config: { ...config.wobbly, tension: 300, friction: 20 },
  });

  const { iconScale, iconRotate } = useSpring({
    iconScale: isHovered ? 1.15 : 1,
    iconRotate: isHovered ? -5 : 0,
    config: { ...config.wobbly, tension: 400, friction: 15 },
  });

  return (
    <motion.button
      key={item.href}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        'w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200 relative group',
        isActive
          ? 'bg-gradient-to-r from-sky-500/20 to-teal-500/10 text-sky-400 border border-sky-500/20 shadow-lg shadow-sky-500/10'
          : 'text-slate-400 hover:text-white hover:bg-white/5'
      )}
    >
      {/* Spring animated hover glow */}
      <animated.div
        style={{ opacity: glowOpacity }}
        className="absolute inset-0 rounded-xl bg-gradient-to-r from-sky-500/10 to-teal-500/10 -z-10"
      />
      
      {/* Spring animated icon */}
      <animated.span style={{ 
        scale: iconScale,
        rotate: iconRotate,
        display: 'inline-block'
      }}>
        <item.icon className={cn('w-5 h-5 transition-colors duration-200', isActive ? 'text-sky-400' : 'text-slate-500')} />
      </animated.span>
      
      <animated.span style={{ x }} className="flex-1">
        {item.label}
      </animated.span>
      
      {/* 3D perspective arrow on active */}
      {isActive && (
        <animated.div
          style={{ scale: iconScale }}
          className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-gradient-to-b from-sky-400 to-teal-500 rounded-r-full"
        />
      )}
    </motion.button>
  );
}

export default function Sidebar3D({ isOpen, onClose }: Sidebar3DProps) {
  const router = useRouter();
  const pathname = usePathname();

  // Sidebar entrance spring
  const { sidebarX } = useSpring({
    from: { sidebarX: -280 },
    to: { sidebarX: isOpen ? 0 : -280 },
    config: { ...config.wobbly, tension: 200, friction: 25 },
  });

  // Logo spring pulse
  const { logoScale } = useSpring({
    from: { logoScale: 1 },
    to: { logoScale: 1 },
    config: config.wobbly,
  });

  return (
    <animated.div
      style={{ 
        transform: sidebarX.to(x => `translateX(${x}px)`), 
      }}
      className="fixed left-0 top-0 h-full w-72 bg-gradient-to-b from-slate-900/95 to-slate-950/95 backdrop-blur-xl border-r border-white/10 z-40 flex flex-col"
    >
      {/* Logo with spring */}
      <div className="p-6 border-b border-white/10">
        <div className="flex items-center gap-3">
          <animated.div 
            style={{ scale: logoScale }}
            className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-teal-600 flex items-center justify-center shadow-lg shadow-sky-500/25"
          >
            <span className="text-white font-bold text-lg">₹</span>
          </animated.div>
          <div>
            <h1 className="text-white font-bold text-lg">GLM Ledger</h1>
            <p className="text-slate-400 text-xs">Accounting Platform</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {menuItems.map((item, index) => (
          <MenuItem
            key={item.href}
            item={item}
            isActive={pathname === item.href}
            onClick={() => {
              router.push(item.href);
              onClose();
            }}
            index={index}
          />
        ))}
      </nav>

      {/* Bottom Actions */}
      <div className="p-4 border-t border-white/10 space-y-1">
        <button className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-white/5 transition-all duration-200">
          <HelpCircle className="w-5 h-5" />
          <span>Help & Support</span>
        </button>
        <button className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-all duration-200">
          <LogOut className="w-5 h-5" />
          <span>Logout</span>
        </button>
      </div>
    </animated.div>
  );
}
