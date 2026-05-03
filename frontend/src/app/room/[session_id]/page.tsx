"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Copy, Users } from "lucide-react";
import { AvatarNode } from "@/components/AvatarNode";
import { ConstraintPanel } from "@/components/ConstraintPanel";
import { DebtMeter } from "@/components/DebtMeter";
import { InterjectInput } from "@/components/InterjectInput";
import { LiveTranscript } from "@/components/LiveTranscript";
import { useSocketStore } from "@/store/socket-store";

export default function RoomPage() {
  const params = useParams<{ session_id: string }>();
  const sessionId = params.session_id;
  const session = useSocketStore((state) => state.session);
  const streaming = useSocketStore((state) => state.streaming);
  const activeSpeaker = useSocketStore((state) => state.activeSpeaker);
  const missingFields = useSocketStore((state) => state.missingFields);
  const consensus = useSocketStore((state) => state.consensus);
  const joinRoom = useSocketStore((state) => state.joinRoom);
  const connect = useSocketStore((state) => state.connect);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    connect();
    joinRoom(sessionId, "Guest").catch(() => undefined);
  }, [connect, joinRoom, sessionId]);

  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/room/${sessionId}` : "";

  return (
    <main className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-amber">Silent Disco Arena</p>
          <h1 className="text-2xl font-semibold">{session?.dilemma ?? "Joining room…"}</h1>
        </div>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(shareUrl);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-sm text-white/75 transition hover:border-amber"
        >
          <Copy size={16} />
          {copied ? "Copied" : "Share"}
        </button>
      </header>

      <div className="grid gap-5 p-5 xl:grid-cols-[1fr_320px]">
        <section className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <AvatarNode
              agent="Optimizer"
              active={activeSpeaker === "Optimizer"}
              sessionStatus={session?.status}
              pendingQuestionAsker={session?.pending_question_asker}
            />
            <AvatarNode
              agent="Vibe-Check"
              active={activeSpeaker === "Vibe-Check"}
              sessionStatus={session?.status}
              pendingQuestionAsker={session?.pending_question_asker}
            />
          </div>

          <DebtMeter balance={session?.debt_balance ?? 0} />

          {consensus && (
            <section className="rounded-lg border border-emerald-300/30 bg-emerald-400/10 p-4">
              <div className="flex items-center gap-2 text-emerald-200">
                <Users size={18} />
                <h2 className="font-semibold">Consensus reached by {consensus.winner}</h2>
              </div>
              <p className="mt-2 text-white/80">{consensus.final_decision}</p>
            </section>
          )}

          <LiveTranscript
            session={session}
            streaming={streaming}
          />
        </section>

        <ConstraintPanel
          constraints={session?.known_constraints ?? {}}
          missingFields={missingFields}
        />
      </div>

      <InterjectInput sessionId={sessionId} />
    </main>
  );
}
