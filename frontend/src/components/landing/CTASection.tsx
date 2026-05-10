'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { ArrowRight, Sparkles } from 'lucide-react';

export default function CTASection() {
  return (
    <section className="relative py-32 px-4 bg-gradient-to-b from-[#1E293B] via-[#0F172A] to-[#0F172A]">
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-sky-500/5 rounded-full blur-3xl" />
      </div>
      
      <div className="relative max-w-4xl mx-auto text-center">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8 }}
        >
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-sky-500/10 border border-sky-500/20 mb-10">
            <Sparkles className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-medium text-sky-400">Limited Time Offer</span>
          </div>
          
          <h2 className="text-5xl md:text-6xl lg:text-7xl font-bold mb-8">
            <span className="bg-gradient-to-r from-sky-300 via-cyan-400 to-teal-300 bg-clip-text text-transparent">
              Ready to Transform Your Accounting?
            </span>
          </h2>
          
          <p className="text-2xl text-slate-300 mb-4 max-w-2xl mx-auto">
            Join thousands of Indian businesses already using GLM Ledger.
          </p>
          
          <p className="text-slate-400 text-xl mb-12 max-w-xl mx-auto">
            Start your 30-day free trial with full access to all features.
            No credit card required.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button
              size="lg"
              className="bg-gradient-to-r from-sky-500 to-teal-500 hover:from-sky-600 hover:to-teal-600 text-white px-12 py-7 text-xl rounded-full shadow-lg shadow-sky-500/25 hover:shadow-sky-500/50 transition-all duration-300 group font-semibold"
            >
              Get Started Free
              <ArrowRight className="ml-2 w-6 h-6 group-hover:translate-x-1 transition-transform" />
            </Button>
            
            <Button
              variant="outline"
              size="lg"
              className="border-white/30 text-white hover:bg-white/10 px-12 py-7 text-xl rounded-full backdrop-blur-sm font-semibold"
            >
              Schedule a Demo
            </Button>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
