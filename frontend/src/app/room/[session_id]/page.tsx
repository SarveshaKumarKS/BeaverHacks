"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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
import type { Participant, TranscriptionSegment } from "livekit-client";
import { Copy, Radio } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectionDetails {
  token: string;
  wsUrl: string;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

interface TranscriptLine {
  id: string;
  speaker: string;
  text: string;
  final: boolean;
}

function speakerName(participant: Participant): string {
  const id = participant.identity.toLowerCase();
  if (id.includes("optimizer")) return "The Optimizer";
  if (id.includes("vibe") || id.includes("check")) return "The Vibe-Check";
  return "You";
}

function speakerColor(speaker: string): string {
  if (speaker === "The Optimizer") return "text-amber-400";
  if (speaker === "The Vibe-Check") return "text-fuchsia-400";
  return "text-sky-400";
}

function useTranscript() {
  const room = useRoomContext();
  const [lines, setLines] = useState<TranscriptLine[]>([]);

  useEffect(() => {
    const onTranscription = (
      segments: TranscriptionSegment[],
      participant: Participant,
    ) => {
      const speaker = speakerName(participant);
      setLines((prev) => {
        const next = [...prev];
        for (const seg of segments) {
          const idx = next.findIndex((l) => l.id === seg.id);
          if (idx >= 0) {
            next[idx] = { ...next[idx], text: seg.text, final: seg.final };
          } else {
            next.push({ id: seg.id, speaker, text: seg.text, final: seg.final });
          }
        }
        return next;
      });
    };

    room.on("transcriptionReceived", onTranscription);
    return () => void room.off("transcriptionReceived", onTranscription);
  }, [room]);

  return lines;
}

function TranscriptPanel() {
  const lines = useTranscript();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  if (lines.length === 0) return null;

  return (
    <div className="w-full max-w-lg rounded-xl border border-white/10 bg-white/5 p-4">
      <p className="mb-2 text-xs uppercase tracking-widest text-white/30">Transcript</p>
      <div className="flex max-h-52 flex-col gap-2 overflow-y-auto pr-1">
        {lines.map((line) => (
          <div key={line.id} className={`text-sm ${line.final ? "opacity-100" : "opacity-50"}`}>
            <span className={`mr-2 font-semibold ${speakerColor(line.speaker)}`}>
              {line.speaker}:
            </span>
            <span className="text-white/80">{line.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner room UI — rendered inside <LiveKitRoom>
// ---------------------------------------------------------------------------

function RoomContent({ dilemma, setDilemma }: { dilemma: string; setDilemma: (d: string) => void }) {
  const { state, audioTrack } = useVoiceAssistant();
  const room = useRoomContext();
  const [speakerLabel, setSpeakerLabel] = useState("");

  useEffect(() => {
    if (room.metadata) setDilemma(room.metadata);
    const onMetadata = () => { if (room.metadata) setDilemma(room.metadata); };
    room.on("roomMetadataChanged", onMetadata);
    return () => void room.off("roomMetadataChanged", onMetadata);
  }, [room, setDilemma]);

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

      {/* Live transcript */}
      <TranscriptPanel />

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
        onDisconnected={() => router.push("/")}
      >
        <RoomContent dilemma={dilemma} setDilemma={setDilemma} />
      </LiveKitRoom>
    </main>
  );
}
