"use client";

import { motion } from "framer-motion";

export function DebtMeter({ balance }: { balance: number }) {
  const normalized = Math.max(0, Math.min(100, 50 + balance * 10));

  return (
    <section className="rounded-lg border border-white/10 bg-panel p-4">
      <div className="mb-3 flex items-center justify-between text-sm text-white/70">
        <span>Optimizer owed</span>
        <span className="font-mono text-white">{balance.toFixed(1)}</span>
        <span>Vibe-Check owed</span>
      </div>
      <div className="relative h-4 overflow-hidden rounded-full bg-white/10">
        <div className="absolute inset-y-0 left-0 w-1/2 bg-sky-400/30" />
        <div className="absolute inset-y-0 right-0 w-1/2 bg-pink-400/30" />
        <motion.div
          className="absolute top-0 h-4 w-1 rounded-full bg-amber"
          animate={{ left: `${normalized}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 18 }}
        />
      </div>
    </section>
  );
}

