"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { ActiveSession } from "@/store/socket-store";

export function LiveTranscript({ session, streaming }: { session: ActiveSession | null; streaming: Record<string, string> }) {
  const endRef = useRef<HTMLDivElement>(null);
  const messages = session?.transcript ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming]);

  return (
    <section className="flex min-h-[420px] flex-1 flex-col rounded-lg border border-white/10 bg-panel">
      <div className="border-b border-white/10 px-4 py-3">
        <h2 className="text-lg font-semibold">Live Transcript</h2>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((message, index) => (
          <MessageBubble key={`${message.speaker}-${index}`} speaker={message.speaker} text={message.text} />
        ))}
        {Object.entries(streaming).map(([speaker, text]) => (
          <MessageBubble key={`stream-${speaker}`} speaker={speaker} text={text} streaming />
        ))}
        <div ref={endRef} />
      </div>
    </section>
  );
}

function MessageBubble({ speaker, text, streaming = false }: { speaker: string; text: string; streaming?: boolean }) {
  const isOptimizer = speaker === "Optimizer";
  const isVibe = speaker === "Vibe-Check";

  return (
    <article
      className={cn(
        "rounded-lg border p-3",
        isOptimizer && "border-sky-300/30 bg-sky-400/10 font-mono",
        isVibe && "border-pink-300/30 bg-pink-400/10",
        !isOptimizer && !isVibe && "border-white/10 bg-white/5"
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className={cn("text-sm font-semibold", isOptimizer && "text-optimizer", isVibe && "text-vibe")}>{speaker}</span>
        {streaming && <span className="text-xs text-amber">typing</span>}
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6 text-white/85">{text}</p>
    </article>
  );
}

