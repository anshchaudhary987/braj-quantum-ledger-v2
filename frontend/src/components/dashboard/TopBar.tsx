'use client';

import React, { useState } from 'react';
import { useSpring, animated, config } from '@react-spring/web';
import { Bell, Search, Settings, ChevronDown } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';

export default function TopBar() {
  const user = useAuthStore((state) => state.user);
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  // Search input spring
  const { searchScale, searchBorderColor } = useSpring({
    searchScale: isSearchFocused ? 1.02 : 1,
    searchBorderColor: isSearchFocused ? 'rgba(14, 165, 233, 0.5)' : 'rgba(255, 255, 255, 0.1)',
    config: config.gentle,
  });

  // Notifications bell spring (continuous bounce)
  const { bellRotate } = useSpring({
    bellRotate: 0,
    config: { ...config.wobbly, tension: 300, friction: 10 },
    loop: { reverse: true },
  });

  // User avatar hover spring
  const [isAvatarHovered, setIsAvatarHovered] = useState(false);
  const { avatarScale } = useSpring({
    avatarScale: isAvatarHovered ? 1.1 : 1,
    config: { ...config.wobbly, tension: 400, friction: 15 },
  });

  return (
    <header className="h-16 bg-gradient-to-r from-slate-900/80 to-slate-950/80 backdrop-blur-xl border-b border-white/10 flex items-center justify-between px-6 z-30">
      {/* Search with spring focus */}
      <div className="flex-1 max-w-xl">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <animated.input
            type="text"
            placeholder="Search transactions, vouchers, reports..."
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => setIsSearchFocused(false)}
            style={{
              scale: searchScale,
              borderColor: searchBorderColor,
              transformOrigin: 'left center',
            }}
            className="w-full pl-10 pr-4 py-2 rounded-xl bg-white/5 border border-white/10 text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500/50 transition-all"
          />
        </div>
      </div>

      {/* Right Side */}
      <div className="flex items-center gap-4">
        {/* Notifications with spring */}
        <button className="relative p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all">
          <animated.div
            style={{
              rotate: bellRotate.to(deg => deg),
            }}
          >
            <Bell className="w-5 h-5" />
          </animated.div>
          <span className="absolute top-1 right-1 w-2 h-2 bg-sky-500 rounded-full animate-pulse" />
        </button>

        {/* Settings with spring hover */}
        <button className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/5 transition-all">
          <Settings className="w-5 h-5" />
        </button>

        {/* User with spring avatar */}
        <div className="flex items-center gap-3 pl-4 border-l border-white/10">
          <animated.div
            style={{ scale: avatarScale }}
            onMouseEnter={() => setIsAvatarHovered(true)}
            onMouseLeave={() => setIsAvatarHovered(false)}
            className="w-8 h-8 rounded-full bg-gradient-to-br from-sky-500 to-teal-600 flex items-center justify-center cursor-pointer"
          >
            <span className="text-white text-sm font-medium">
              {user?.name?.charAt(0).toUpperCase() || 'U'}
            </span>
          </animated.div>
          <div className="hidden md:block">
            <p className="text-sm font-medium text-white">{user?.name || 'User'}</p>
            <p className="text-xs text-slate-400">{user?.current_company_name || 'Company'}</p>
          </div>
          <ChevronDown className="w-4 h-4 text-slate-400" />
        </div>
      </div>
    </header>
  );
}
