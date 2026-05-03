"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  LiveKitRoom,
  BarVisualizer,
  VoiceAssistantControlBar,
  RoomAudioRenderer,
  useVoiceAssistant,
  useRoomContext,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Copy, Radio } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectionDetails {
  token: string;
  wsUrl: string;
}

// ---------------------------------------------------------------------------
// Inner room UI — rendered inside <LiveKitRoom>
// ---------------------------------------------------------------------------

function RoomContent({ dilemma }: { dilemma: string }) {
  const { state, audioTrack } = useVoiceAssistant();
  const room = useRoomContext();
  const [speakerLabel, setSpeakerLabel] = useState("");

  useEffect(() => {
    const onActiveChange = () => {
      const active = Array.from(room.remoteParticipants.values()).find(
        (p) => p.isSpeaking,
      );
      if (active) {
        const id = active.identity.toLowerCase();
        if (id.includes("optimizer")) setSpeakerLabel("The Optimizer");
        else if (id.includes("vibe") || id.includes("check")) setSpeakerLabel("The Vibe-Check");
        else setSpeakerLabel(active.identity);
      } else {
        setSpeakerLabel("");
      }
    };
    room.on("activeSpeakersChanged", onActiveChange);
    return () => void room.off("activeSpeakersChanged", onActiveChange);
  }, [room]);

  const statusLabel: Record<string, string> = {
    disconnected: "Waiting for agents…",
    connecting: "Agents connecting…",
    initializing: "Initializing…",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: speakerLabel ? `${speakerLabel} is speaking` : "Speaking…",
  };

  return (
    <div className="flex flex-col items-center gap-8 px-4 py-10">
      {dilemma && (
        <p className="max-w-xl text-center text-lg font-medium text-white/80">
          &ldquo;{dilemma}&rdquo;
        </p>
      )}

      {/* Agent avatar cards */}
      <div className="grid w-full max-w-lg grid-cols-2 gap-4">
        <AgentCard
          name="The Optimizer"
          emoji="🧠"
          accentClass="ring-amber-400 bg-amber-400/10"
          isActive={speakerLabel === "The Optimizer"}
        />
        <AgentCard
          name="The Vibe-Check"
          emoji="✨"
          accentClass="ring-fuchsia-400 bg-fuchsia-400/10"
          isActive={speakerLabel === "The Vibe-Check"}
        />
      </div>

      {/* Live audio bar visualizer */}
      <div className="flex w-full max-w-lg flex-col items-center gap-3">
        <BarVisualizer
          state={state}
          barCount={24}
          trackRef={audioTrack}
          style={{ width: "100%", height: 64 }}
        />
        <p className="text-sm text-white/50">{statusLabel[state] ?? state}</p>
      </div>

      {/* Mic / disconnect controls */}
      <VoiceAssistantControlBar controls={{ leave: true }} />

      {/* Renders all remote audio tracks so the agents can be heard */}
      <RoomAudioRenderer />
    </div>
  );
}

function AgentCard({
  name,
  emoji,
  accentClass,
  isActive,
}: {
  name: string;
  emoji: string;
  accentClass: string;
  isActive: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-2 rounded-xl border border-white/10 p-4 transition-all duration-300 ${isActive ? `ring-2 shadow-lg ${accentClass}` : "bg-white/5"}`}
    >
      <span className="text-4xl">{emoji}</span>
      <span className="text-center text-sm font-semibold text-white/80">{name}</span>
      {isActive && (
        <span className="flex items-center gap-1 text-xs text-white/50">
          <Radio size={10} className="animate-pulse" />
          speaking
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RoomPage() {
  const params = useParams<{ session_id: string }>();
  const router = useRouter();
  const roomName = params.session_id;

  const [connectionDetails, setConnectionDetails] = useState<ConnectionDetails | null>(null);
  const [dilemma, setDilemma] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const shareUrl =
    typeof window !== "undefined" ? `${window.location.origin}/room/${roomName}` : "";

  useEffect(() => {
    async function fetchToken() {
      // Reuse cached token if the host navigated here from the landing page
      const cachedToken = sessionStorage.getItem(`lk-token-${roomName}`);
      const cachedWsUrl = sessionStorage.getItem(`lk-wsurl-${roomName}`);
      if (cachedToken && cachedWsUrl) {
        setConnectionDetails({ token: cachedToken, wsUrl: cachedWsUrl });
        return;
      }
      // Guest path — fetch a fresh participant token for the existing room
      try {
        const res = await fetch(
          `/api/token?room=${encodeURIComponent(roomName)}&identity=guest-${Date.now()}`,
        );
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as { token: string; wsUrl: string };
        setConnectionDetails({ token: data.token, wsUrl: data.wsUrl });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not connect");
      }
    }
    fetchToken();
  }, [roomName]);

  const onCopy = useCallback(async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [shareUrl]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-red-300">{error}</p>
      </main>
    );
  }

  if (!connectionDetails) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse text-white/50">Connecting to arena…</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-amber">The Decider — Live Arena</p>
          <h1 className="text-xl font-semibold text-white/90">{dilemma || roomName}</h1>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-sm text-white/75 transition hover:border-amber"
        >
          <Copy size={16} />
          {copied ? "Copied" : "Share"}
        </button>
      </header>

      <LiveKitRoom
        serverUrl={connectionDetails.wsUrl}
        token={connectionDetails.token}
        audio={true}
        video={false}
        onConnected={(room) => {
          if (room.metadata) setDilemma(room.metadata);
        }}
        onDisconnected={() => router.push("/")}
      >
        <RoomContent dilemma={dilemma} />
      </LiveKitRoom>
    </main>
  );
}
