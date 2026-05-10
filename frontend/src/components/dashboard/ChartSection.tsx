'use client';

import React, { useState } from 'react';
import { useSpring, animated, config } from '@react-spring/web';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useRevenueData } from '@/hooks/useDashboardData';

export default function ChartSection() {
  const [hoveredData, setHoveredData] = useState<{name: string; revenue: number; expenses: number} | null>(null);
  const [isChartHovered, setIsChartHovered] = useState(false);
  
  const { data: revenueData, isLoading } = useRevenueData();

  // Chart card 3D spring
  const { transform, boxShadow } = useSpring({
    transform: isChartHovered
      ? 'perspective(1000px) rotateX(2deg) rotateY(-2deg) scale(1.01)'
      : 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale(1)',
    boxShadow: isChartHovered
      ? '0 25px 50px -12px rgba(14, 165, 233, 0.15)'
      : '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
    config: { ...config.wobbly, tension: 300, friction: 20 },
  });

  // Title spring
  const titleSpring = useSpring({
    from: { opacity: 0, y: 20 },
    to: { opacity: 1, y: 0 },
    config: config.gentle,
    delay: 200,
  });

  // Hover tooltip spring
  const hoverSpring = useSpring({
    opacity: hoveredData ? 1 : 0,
    y: hoveredData ? 0 : -10,
    config: config.gentle,
  });

  if (isLoading || !revenueData) {
    return (
      <div className="p-8 rounded-3xl bg-white/5 border border-white/10 backdrop-blur-sm">
        <div className="animate-pulse">
          <div className="h-6 bg-white/10 rounded w-48 mb-4" />
          <div className="h-4 bg-white/10 rounded w-64 mb-8" />
          <div className="h-80 bg-white/5 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <animated.div
      style={{
        transform,
        boxShadow,
      }}
      onMouseEnter={() => setIsChartHovered(true)}
      onMouseLeave={() => setIsChartHovered(false)}
      className="p-8 rounded-3xl bg-white/5 border border-white/10 backdrop-blur-sm cursor-pointer"
    >
      <div className="flex items-center justify-between mb-8">
        <div>
          <h3 className="text-xl font-semibold text-white mb-1">Revenue vs Expenses</h3>
          <p className="text-slate-400 text-sm">Financial performance over last 6 months</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-sky-500 animate-pulse" />
            <span className="text-slate-400 text-xs">Revenue</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
            <span className="text-slate-400 text-xs">Expenses</span>
          </div>
        </div>
      </div>

      {/* Hover tooltip with spring */}
      <animated.div
        style={hoverSpring}
        className="mb-4 p-4 rounded-xl bg-sky-500/10 border border-sky-500/20"
      >
        {hoveredData && (
          <div className="flex items-center justify-between">
            <span className="text-sky-400 font-semibold">{hoveredData.name}</span>
            <span className="text-white">Revenue: ₹{hoveredData.revenue.toLocaleString()}</span>
            <span className="text-white">Expenses: ₹{hoveredData.expenses.toLocaleString()}</span>
          </div>
        )}
      </animated.div>

      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart 
            data={revenueData} 
            margin={{ top: 5, right: 5, left: 5, bottom: 5 }}
            onMouseMove={(e) => {
              if (e.activePayload) {
                setHoveredData(e.activePayload[0].payload);
              }
            }}
            onMouseLeave={() => setHoveredData(null)}
          >
            <defs>
              <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="expenseGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis 
              dataKey="name" 
              stroke="#64748b" 
              fontSize={12}
              tickLine={false}
              axisLine={false}
            />
            <YAxis 
              stroke="#64748b" 
              fontSize={12}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => `₹${value / 1000}K`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '12px',
                color: '#fff',
              }}
              formatter={(value) => [`₹${Number(value).toLocaleString()}`, '']}
            />
            <Area
              type="monotone"
              dataKey="revenue"
              stroke="#0ea5e9"
              strokeWidth={2}
              fill="url(#revenueGradient)"
            />
            <Area
              type="monotone"
              dataKey="expenses"
              stroke="#ef4444"
              strokeWidth={2}
              fill="url(#expenseGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </animated.div>
  );
}
