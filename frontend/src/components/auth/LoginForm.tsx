'use client';

import React, { useState } from 'react';
import { useSpring, animated, config } from '@react-spring/web';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { Eye, EyeOff, Loader2 } from 'lucide-react';

// Spring animated form container
function SpringFormContainer({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const springProps = useSpring({
    from: { opacity: 0, transform: 'translateY(30px) scale(0.95)' },
    to: { opacity: 1, transform: 'translateY(0px) scale(1)' },
    config: { ...config.wobbly, tension: 150, friction: 18 },
  });

  return (
    <animated.div style={springProps} className={className}>
      {children}
    </animated.div>
  );
}

// Spring animated input field
function SpringInput({ label, type = 'text', showPasswordToggle, ...props }: any) {
  const [isFocused, setIsFocused] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const inputType = showPasswordToggle ? (showPassword ? 'text' : 'password') : type;

  const { scale, borderColor } = useSpring({
    scale: isFocused ? 1.02 : 1,
    borderColor: isFocused ? 'rgba(14, 165, 233, 0.5)' : 'rgba(255, 255, 255, 0.1)',
    config: config.gentle,
  });

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-slate-300">{label}</label>
      <div className="relative">
        <animated.input
          type={inputType}
          style={{ scale }}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          className="w-full px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-500/50 focus:border-sky-500/50 transition-all pr-12"
          {...props}
        />
        {showPasswordToggle && (
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors"
          >
            {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
          </button>
        )}
      </div>
    </div>
  );
}

// Spring animated button with ripple
function SpringButton({ children, isLoading, ...props }: any) {
  const [{ scale }, api] = useSpring(() => ({
    scale: 1,
    config: { ...config.wobbly, tension: 400, friction: 15 },
  }));

  const handleMouseDown = () => api.start({ scale: 0.95 });
  const handleMouseUp = () => api.start({ scale: 1 });

  return (
    <animated.div style={{ scale }} className="w-full" onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
      <Button disabled={isLoading} className="w-full bg-gradient-to-r from-teal-500 to-sky-500 hover:from-teal-600 hover:to-sky-600 text-white py-3 rounded-lg shadow-lg shadow-teal-500/25 transition-all duration-300" {...props}>
        {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : children}
      </Button>
    </animated.div>
  );
}

export default function LoginForm() {
  const router = useRouter();
  const { login, isLoading, error, setError } = useAuth();
  
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    const success = await login({
      email: formData.email,
      password: formData.password,
    });
  };

  return (
    <SpringFormContainer className="w-full max-w-md mx-auto">
      <div className="p-8 rounded-2xl bg-white/5 border border-white/10 backdrop-blur-sm">
        <div className="text-center mb-8">
          <h2 className="text-2xl font-bold text-white mb-2">Welcome Back</h2>
          <p className="text-slate-400">Sign in to your GLM Ledger account</p>
        </div>

        {error && (
          <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <SpringInput
            label="Email Address"
            type="email"
            value={formData.email}
            onChange={(e: any) => setFormData({ ...formData, email: e.target.value })}
            required
            placeholder="you@company.com"
          />

          <SpringInput
            label="Password"
            showPasswordToggle
            value={formData.password}
            onChange={(e: any) => setFormData({ ...formData, password: e.target.value })}
            required
            placeholder="Enter your password"
          />

          <div className="flex items-center justify-between text-sm">
            <label className="flex items-center gap-2 text-slate-400 cursor-pointer">
              <input type="checkbox" className="rounded bg-white/5 border-white/10 text-sky-500 focus:ring-sky-500/50" />
              <span>Remember me</span>
            </label>
            <button type="button" className="text-sky-400 hover:text-sky-300 transition-colors">
              Forgot password?
            </button>
          </div>

          <SpringButton isLoading={isLoading} type="submit">
            Sign In
          </SpringButton>
        </form>

        <div className="mt-6 text-center">
          <p className="text-slate-400 text-sm">
            Don&apos;t have an account?{' '}
            <button
              type="button"
              onClick={() => router.push('/register')}
              className="text-sky-400 hover:text-sky-300 transition-colors font-medium"
            >
              Create one now
            </button>
          </p>
        </div>
      </div>
    </SpringFormContainer>
  );
}
