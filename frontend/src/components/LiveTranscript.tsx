"use client";

import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTTS } from "@/lib/useTTS";
import type { ActiveSession } from "@/store/socket-store";

type Props = {
  session: ActiveSession | null;
  streaming: Record<string, string>;
};

export function LiveTranscript({ session, streaming }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const messages = session?.transcript ?? [];
  const [ttsEnabled, setTtsEnabled] = useState(true);

  useTTS({
    messages,
    sessionStatus: session?.status ?? "speaking",
    enabled: ttsEnabled,
    ttsEndpoint: process.env.NEXT_PUBLIC_TTS_ENDPOINT ?? null,
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming]);

  return (
    <section className="flex min-h-[420px] flex-1 flex-col rounded-lg border border-white/10 bg-panel">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h2 className="text-lg font-semibold">Live Transcript</h2>
        <button
          type="button"
          title={ttsEnabled ? "Mute agent voices" : "Unmute agent voices"}
          onClick={() => setTtsEnabled((v) => !v)}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition",
            ttsEnabled
              ? "border-amber/50 text-amber hover:border-amber"
              : "border-white/10 text-white/40 hover:border-white/30"
          )}
        >
          {ttsEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
          {ttsEnabled ? "Voice On" : "Voice Off"}
        </button>
      </div>

      {/* Status banner */}
      <StatusBanner status={session?.status ?? null} asker={session?.pending_question_asker ?? null} />

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

function StatusBanner({
  status,
  asker,
}: {
  status: string | null;
  asker: string | null;
}) {
  if (!status || status === "speaking" || status === "consensus_reached") return null;

  const banners: Record<string, { label: string; className: string }> = {
    user_interrupting: {
      label: "Wrapping up thought…",
      className: "border-amber/40 bg-amber/10 text-amber",
    },
    awaiting_user_answer: {
      label: asker ? `${asker} asked a question — your turn` : "Waiting for your answer…",
      className: "border-sky-400/40 bg-sky-400/10 text-sky-200",
    },
    resuming_with_new_context: {
      label: "Resuming with your input…",
      className: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
    },
  };

  const banner = banners[status];
  if (!banner) return null;

  return (
    <div className={cn("flex items-center gap-2 border-b px-4 py-2 text-xs font-medium", banner.className)}>
      <span className="animate-pulse">●</span>
      {banner.label}
    </div>
  );
}

function MessageBubble({
  speaker,
  text,
  streaming = false,
}: {
  speaker: string;
  text: string;
  streaming?: boolean;
}) {
  const isOptimizer = speaker === "Optimizer";
  const isVibe = speaker === "Vibe-Check";

  // Strip bracket tags from display
  const displayText = text
    .replace(/\[INTERROGATE:[^\]]*\]/gi, "")
    .replace(/\[CONSENSUS_REACHED\]:/gi, "✓ Decision:")
    .trim();

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
        <span className={cn("text-sm font-semibold", isOptimizer && "text-optimizer", isVibe && "text-vibe")}>
          {speaker}
        </span>
        {streaming && (
          <span className="flex items-center gap-1 text-xs text-amber">
            <span className="inline-flex gap-0.5">
              <span className="animate-bounce" style={{ animationDelay: "0ms" }}>·</span>
              <span className="animate-bounce" style={{ animationDelay: "150ms" }}>·</span>
              <span className="animate-bounce" style={{ animationDelay: "300ms" }}>·</span>
            </span>
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6 text-white/85">{displayText}</p>
    </article>
  );
}
