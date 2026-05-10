'use client';

import React from 'react';
import Head from 'next/head';
import dynamic from 'next/dynamic';
import LoginForm from '@/components/auth/LoginForm';
import { motion } from 'framer-motion';

const Background3D = dynamic(() => import('@/components/3d/Background3D'), {
  ssr: false,
  loading: () => null,
});

export default function LoginPage() {
  return (
    <>
      <Head>
        <title>Sign In — GLM Ledger</title>
        <meta name="description" content="Sign in to your GLM Ledger account" />
      </Head>

      <div className="relative min-h-screen flex items-center justify-center bg-[#0F172A] overflow-hidden">
        {/* 3D Background */}
        <Background3D />

        {/* Content */}
        <div className="relative z-10 w-full max-w-md mx-auto px-4">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center mb-8"
          >
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sky-500 to-teal-600 flex items-center justify-center mx-auto mb-6 shadow-lg shadow-sky-500/25">
              <span className="text-white font-bold text-2xl">₹</span>
            </div>
            <h1 className="text-3xl font-bold text-white mb-2">Welcome to GLM Ledger</h1>
            <p className="text-slate-400">Sign in to manage your accounts</p>
          </motion.div>

          <LoginForm />
        </div>
      </div>
    </>
  );
}
