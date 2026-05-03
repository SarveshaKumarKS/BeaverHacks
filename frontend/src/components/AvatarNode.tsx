"use client";

import { motion } from "framer-motion";
import { Cpu, HelpCircle, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentName, SessionStatus } from "@/store/socket-store";

type Props = {
  agent: AgentName;
  active: boolean;
  sessionStatus?: SessionStatus | null;
  pendingQuestionAsker?: AgentName | null;
};

function getStatusLabel(
  agent: AgentName,
  active: boolean,
  sessionStatus: SessionStatus | null | undefined,
  pendingQuestionAsker: AgentName | null | undefined
): { label: string; pulse: boolean } {
  if (sessionStatus === "consensus_reached") return { label: "Agreed", pulse: false };
  if (sessionStatus === "awaiting_user_answer") {
    if (agent === pendingQuestionAsker) return { label: "Asked — waiting", pulse: true };
    return { label: "Waiting for user", pulse: false };
  }
  if (sessionStatus === "user_interrupting") {
    if (active) return { label: "Wrapping up…", pulse: true };
    return { label: "On hold", pulse: false };
  }
  if (active) return { label: "Speaking", pulse: true };
  return { label: "Listening", pulse: false };
}

export function AvatarNode({ agent, active, sessionStatus, pendingQuestionAsker }: Props) {
  const isOptimizer = agent === "Optimizer";
  const Icon = isOptimizer ? Cpu : Sparkles;
  const { label, pulse } = getStatusLabel(agent, active, sessionStatus, pendingQuestionAsker);

  const isWrappingUp = active && sessionStatus === "user_interrupting";
  const isAsker = sessionStatus === "awaiting_user_answer" && agent === pendingQuestionAsker;

  const scaleAnim = active ? [1, 1.04, 1] : isAsker ? [1, 1.02, 1] : 1;

  return (
    <motion.div
      animate={{ scale: scaleAnim }}
      transition={{ repeat: pulse ? Infinity : 0, duration: active ? 1.1 : 1.6, ease: "easeInOut" }}
      className={cn(
        "flex min-h-40 flex-1 flex-col justify-between rounded-lg border bg-panel p-5",
        isOptimizer ? "border-sky-400/40" : "border-pink-400/40",
        active && (isOptimizer ? "shadow-optimizer" : "shadow-vibe"),
        !active && "shadow-none"
      )}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-white/45">
            {isOptimizer ? "Agent A" : "Agent B"}
          </p>
          <h2 className={cn("mt-1 text-2xl font-semibold", isOptimizer ? "text-optimizer" : "text-vibe")}>
            {agent}
          </h2>
        </div>
        <div
          className={cn(
            "rounded-full border p-3",
            isOptimizer ? "border-sky-300/50 text-optimizer" : "border-pink-300/50 text-vibe"
          )}
        >
          {isAsker ? (
            <HelpCircle size={28} />
          ) : isWrappingUp ? (
            <Loader2 size={28} className="animate-spin" />
          ) : (
            <Icon size={28} />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-white/60">
          {isOptimizer
            ? "Efficiency, cost, ROI, and surgical impatience."
            : "Morale, culture, aesthetics, and dramatic accuracy."}
        </p>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
            pulse
              ? isOptimizer
                ? "bg-sky-400/20 text-sky-300"
                : "bg-pink-400/20 text-pink-300"
              : "bg-white/5 text-white/30"
          )}
        >
          {label}
        </span>
      </div>
    </motion.div>
  );
}
