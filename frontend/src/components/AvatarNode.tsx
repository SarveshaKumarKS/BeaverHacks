"use client";

import { motion } from "framer-motion";
import { Cpu, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentName } from "@/store/socket-store";

type Props = {
  agent: AgentName;
  active: boolean;
};

export function AvatarNode({ agent, active }: Props) {
  const isOptimizer = agent === "Optimizer";
  const Icon = isOptimizer ? Cpu : Sparkles;

  return (
    <motion.div
      animate={{ scale: active ? [1, 1.04, 1] : 1 }}
      transition={{ repeat: active ? Infinity : 0, duration: 1.2 }}
      className={cn(
        "flex min-h-40 flex-1 flex-col justify-between rounded-lg border bg-panel p-5",
        isOptimizer ? "border-sky-400/40 shadow-optimizer" : "border-pink-400/40 shadow-vibe",
        !active && "shadow-none"
      )}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-white/45">{isOptimizer ? "Agent A" : "Agent B"}</p>
          <h2 className={cn("mt-1 text-2xl font-semibold", isOptimizer ? "text-optimizer" : "text-vibe")}>{agent}</h2>
        </div>
        <div className={cn("rounded-full border p-3", isOptimizer ? "border-sky-300/50 text-optimizer" : "border-pink-300/50 text-vibe")}>
          <Icon size={28} />
        </div>
      </div>
      <p className="text-sm text-white/60">{isOptimizer ? "Efficiency, cost, ROI, and surgical impatience." : "Morale, culture, aesthetics, and dramatic accuracy."}</p>
    </motion.div>
  );
}

