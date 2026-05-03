"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  LiveKitRoom,
  BarVisualizer,
  RoomAudioRenderer,
  useVoiceAssistant,
  useRoomContext,
  useLocalParticipant,
  useParticipants,
} from "@livekit/components-react";
import type { Participant, TranscriptionSegment } from "livekit-client";
import QRCode from "qrcode";
import { ArrowRight, CheckCircle, Copy, LogOut, Mic, MicOff, QrCode, Radio, Users } from "lucide-react";

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

function speakerName(participant: Participant, localIdentity: string): string {
  if (participant.identity === localIdentity) return "You";
  const id = participant.identity.toLowerCase();
  if (id === "optimizer") return "The Optimizer";
  if (id === "vibe-check") return "The Vibe-Check";
  return participant.identity;
}

function speakerColor(speaker: string): string {
  if (speaker === "The Optimizer") return "text-amber-400";
  if (speaker === "The Vibe-Check") return "text-fuchsia-400";
  if (speaker === "You") return "text-sky-400";
  return "text-emerald-400";
}

function useTranscript() {
  const room = useRoomContext();
  const [lines, setLines] = useState<TranscriptLine[]>([]);

  useEffect(() => {
    const localIdentity = room.localParticipant.identity;
    const onTranscription = (
      segments: TranscriptionSegment[],
      participant?: Participant,
    ) => {
      if (!participant) return;
      const speaker = speakerName(participant, localIdentity);
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

// ---------------------------------------------------------------------------
// Speaker selector — N buttons, one per participant
// ---------------------------------------------------------------------------

function SpeakerSelector({ participants }: { participants: string[] }) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [active, setActive] = useState<string | null>(null);

  if (participants.length === 0) return null;

  function selectSpeaker(name: string) {
    if (active === name) {
      // Tap active name again — mute and deselect
      setActive(null);
      localParticipant.setMicrophoneEnabled(false);
      const payload = new TextEncoder().encode(JSON.stringify({ type: "speaker", name: "" }));
      room.localParticipant.publishData(payload, { reliable: true });
    } else {
      setActive(name);
      localParticipant.setMicrophoneEnabled(true);
      const payload = new TextEncoder().encode(JSON.stringify({ type: "speaker", name }));
      room.localParticipant.publishData(payload, { reliable: true });
    }
  }

  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-3">
      <p className="text-xs uppercase tracking-widest text-white/30">Tap your name to speak</p>
      <div className="flex flex-wrap justify-center gap-2">
        {participants.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => selectSpeaker(name)}
            className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
              active === name
                ? "bg-amber-400 text-black shadow-lg"
                : "bg-white/10 text-white/70 hover:bg-white/20"
            }`}
          >
            {active === name && <Mic size={13} />}
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function RoomContent({ dilemma, participants, onLeave }: { dilemma: string; participants: string[]; onLeave: () => void }) {
  const { state, audioTrack } = useVoiceAssistant();
  const room = useRoomContext();
  const [speakerLabel, setSpeakerLabel] = useState("");
  const [consensusSent, setConsensusSent] = useState(false);

  function sendConsensus() {
    if (consensusSent) return;
    setConsensusSent(true);
    const payload = new TextEncoder().encode(JSON.stringify({ type: "consensus" }));
    room.localParticipant.publishData(payload, { reliable: true });
  }

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

      {/* Speaker selector — tap before speaking */}
      <SpeakerSelector participants={participants} />

      {/* Live transcript */}
      <TranscriptPanel />

      {/* Consensus + leave controls */}
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={sendConsensus}
          disabled={consensusSent}
          className={`flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold transition ${
            consensusSent
              ? "bg-emerald-500/10 text-emerald-400/50 cursor-default"
              : "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
          }`}
        >
          <CheckCircle size={16} />
          {consensusSent ? "Wrapping up…" : "We've decided!"}
        </button>
        <ParticipantControls onLeave={onLeave} showMic={participants.length === 0} />
      </div>

      {/* Renders all remote audio tracks so the agents can be heard */}
      <RoomAudioRenderer />
    </div>
  );
}

function ParticipantControls({ onLeave, showMic }: { onLeave: () => void; showMic: boolean }) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();

  useEffect(() => {
    // When speaker buttons handle the mic, start muted; otherwise auto-enable
    localParticipant.setMicrophoneEnabled(showMic);
  }, [localParticipant, showMic]);

  return (
    <div className="flex items-center gap-3">
      {showMic && (
        <button
          type="button"
          onClick={() => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}
          className={`flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition ${
            isMicrophoneEnabled
              ? "bg-white/10 text-white hover:bg-white/20"
              : "bg-red-500/20 text-red-400 hover:bg-red-500/30"
          }`}
        >
          {isMicrophoneEnabled ? <Mic size={16} /> : <MicOff size={16} />}
          {isMicrophoneEnabled ? "Mute" : "Unmute"}
        </button>
      )}
      <button
        type="button"
        onClick={onLeave}
        className="flex items-center gap-2 rounded-full bg-red-500/20 px-5 py-3 text-sm font-semibold text-red-400 transition hover:bg-red-500/30"
      >
        <LogOut size={16} />
        Leave
      </button>
    </div>
  );
}

function QRButton({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState("");

  useEffect(() => {
    if (!url) return;
    QRCode.toDataURL(url, { width: 200, margin: 2, color: { dark: "#ffffff", light: "#0d1117" } })
      .then(setDataUrl)
      .catch(() => {});
  }, [url]);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-sm text-white/75 transition hover:border-fuchsia-400"
      >
        <QrCode size={16} />
        Invite
      </button>
      {open && dataUrl && (
        <div className="absolute right-0 top-full z-50 mt-2 rounded-xl border border-white/10 bg-[#0d1117] p-4 shadow-xl">
          <p className="mb-2 text-center text-xs text-white/50">Scan to join</p>
          <img src={dataUrl} alt="QR code" width={160} height={160} />
        </div>
      )}
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
// Waiting room — shown before host clicks Start
// ---------------------------------------------------------------------------

const AGENT_IDENTITIES = new Set(["optimizer", "vibe-check"]);

function WaitingRoom({ roomName, dilemma, participants, locationCtx }: { roomName: string; dilemma: string; participants: string[]; locationCtx: string }) {
  const room = useRoomContext();
  const allParticipants = useParticipants();
  const [starting, setStarting] = useState(false);

  const isHost = room.localParticipant.identity.startsWith("host-");
  const humans = allParticipants.filter((p) => !AGENT_IDENTITIES.has(p.identity));

  async function startDebate() {
    setStarting(true);
    try {
      await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, dilemma, participants, location: locationCtx }),
      });
    } catch {
      setStarting(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-8 px-4 py-16">
      {dilemma && (
        <p className="max-w-xl text-center text-lg font-medium text-white/80">
          &ldquo;{dilemma}&rdquo;
        </p>
      )}

      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-white/5 p-6">
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-white/40">
          <Users size={14} />
          Participants ({humans.length})
        </div>
        <ul className="flex flex-col gap-2">
          {humans.map((p) => {
            const isLocal = p.identity === room.localParticipant.identity;
            const label = p.identity.startsWith("host-")
              ? `Host${isLocal ? " (You)" : ""}`
              : isLocal
                ? `${p.identity} (You)`
                : p.identity;
            return (
              <li key={p.identity} className="flex items-center gap-2 text-sm text-white/70">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                {label}
              </li>
            );
          })}
        </ul>
      </div>

      {isHost ? (
        <button
          type="button"
          onClick={startDebate}
          disabled={starting || !locationCtx}
          className="flex items-center gap-2 rounded-md bg-amber-400 px-8 py-4 text-lg font-semibold text-black transition hover:bg-amber-300 disabled:opacity-50"
        >
          {starting ? "Starting…" : !locationCtx ? "Getting location…" : "Start Debate"}
          <ArrowRight size={20} />
        </button>
      ) : (
        <p className="animate-pulse text-sm text-white/40">Waiting for host to start the debate…</p>
      )}

      <RoomAudioRenderer />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoomInner — handles metadata, routes between waiting / live views
// ---------------------------------------------------------------------------

function RoomInner({
  roomName,
  dilemma,
  setDilemma,
  participants,
  locationCtx,
  onLeave,
}: {
  roomName: string;
  dilemma: string;
  setDilemma: (d: string) => void;
  participants: string[];
  locationCtx: string;
  onLeave: () => void;
}) {
  const room = useRoomContext();
  const [started, setStarted] = useState(false);

  useEffect(() => {
    function parseMeta() {
      try {
        const m = JSON.parse(room.metadata || "{}");
        if (m.dilemma) setDilemma(m.dilemma);
        if (m.status === "started") setStarted(true);
      } catch {
        if (room.metadata) setDilemma(room.metadata);
      }
    }
    parseMeta();
    room.on("roomMetadataChanged", parseMeta);
    return () => void room.off("roomMetadataChanged", parseMeta);
  }, [room, setDilemma]);

  if (!started) return <WaitingRoom roomName={roomName} dilemma={dilemma} participants={participants} locationCtx={locationCtx} />;
  return <RoomContent dilemma={dilemma} participants={participants} onLeave={onLeave} />;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RoomPage() {
  const params = useParams<{ session_id: string }>();
  const router = useRouter();
  const roomName = params.session_id;

  const [connectionDetails, setConnectionDetails] = useState<ConnectionDetails | null>(null);
  const [dilemma, setDilemma] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return sessionStorage.getItem(`lk-dilemma-${roomName}`) ?? "";
  });
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [locationCtx, setLocationCtx] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return sessionStorage.getItem(`lk-location-${roomName}`) ?? "";
  });
  const [participants] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(sessionStorage.getItem(`lk-participants-${roomName}`) ?? "[]");
    } catch {
      return [];
    }
  });

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

  useEffect(() => {
    // Host already has location from landing page (sessionStorage) — skip for guests only
    if (locationCtx) return;

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localTime = new Date().toLocaleString("en-US", {
      timeZone: timezone,
      weekday: "long",
      hour: "numeric",
      minute: "numeric",
      hour12: true,
    });

    async function resolveLocationFromIP() {
      try {
        const res = await fetch("https://ipapi.co/json/");
        const data = await res.json();
        const city = data.city || data.region || "Unknown city";
        const country = data.country_name || "";
        setLocationCtx(`${localTime}, ${city}, ${country}`);
      } catch {
        setLocationCtx(`${localTime}, ${timezone}`);
      }
    }

    if (!navigator.geolocation) {
      resolveLocationFromIP();
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json`,
            { headers: { "Accept-Language": "en" } },
          );
          const data = await res.json();
          const city =
            data.address?.city ||
            data.address?.town ||
            data.address?.village ||
            "Unknown city";
          const country = data.address?.country || "";
          setLocationCtx(`${localTime}, ${city}, ${country}`);
        } catch {
          setLocationCtx(`${localTime}, ${timezone}`);
        }
      },
      () => resolveLocationFromIP(),
      { timeout: 5000 },
    );
  }, []);

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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-sm text-white/75 transition hover:border-amber-400"
          >
            <Copy size={16} />
            {copied ? "Copied" : "Share"}
          </button>
          <QRButton url={shareUrl} />
        </div>
      </header>

      <LiveKitRoom
        serverUrl={connectionDetails.wsUrl}
        token={connectionDetails.token}
        audio={true}
        video={false}
        onDisconnected={() => router.push("/")}
      >
        <RoomInner
          roomName={roomName}
          dilemma={dilemma}
          setDilemma={setDilemma}
          participants={participants}
          locationCtx={locationCtx}
          onLeave={() => router.push("/")}
        />
      </LiveKitRoom>
    </main>
  );
}
