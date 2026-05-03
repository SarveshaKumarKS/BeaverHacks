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
import { ArrowRight, CheckCircle, Copy, LogOut, Mic, MicOff, QrCode, Users } from "lucide-react";

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

function normalizeText(t: string): string {
  return t.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
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
          } else if (speaker === "You" && seg.text.length > 10) {
            // Both agent sessions transcribe user audio → deduplicate by normalized text
            const norm = normalizeText(seg.text);
            let dupIdx = -1;
            for (let i = next.length - 1; i >= Math.max(0, next.length - 10); i--) {
              if (next[i].speaker === "You" && normalizeText(next[i].text) === norm) {
                dupIdx = i;
                break;
              }
            }
            if (dupIdx >= 0) {
              next[dupIdx] = { ...next[dupIdx], text: seg.text, final: next[dupIdx].final || seg.final };
            } else {
              next.push({ id: seg.id, speaker, text: seg.text, final: seg.final });
            }
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
    <div className="w-full max-w-lg border border-white/10 p-4">
      <p className="mb-3 font-mono text-xs uppercase tracking-widest text-white/25">Transcript</p>
      <div className="flex max-h-52 flex-col gap-2 overflow-y-auto pr-1">
        {lines.map((line) => (
          <div key={line.id} className={`text-sm leading-snug ${line.final ? "opacity-100" : "opacity-40"}`}>
            <span className={`mr-2 font-mono text-xs uppercase tracking-widest ${speakerColor(line.speaker)}`}>
              {line.speaker}
            </span>
            <span className="text-white/70">{line.text}</span>
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
      <p className="font-mono text-xs uppercase tracking-widest text-white/25">Tap your name to speak</p>
      <div className="flex flex-wrap justify-center gap-2">
        {participants.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => selectSpeaker(name)}
            className={`flex items-center gap-2 rounded-full px-4 py-2 font-mono text-xs uppercase tracking-widest transition ${
              active === name
                ? "bg-amber text-black"
                : "border border-white/15 text-white/50 hover:border-amber/50 hover:text-white/80"
            }`}
          >
            {active === name && <Mic size={11} />}
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
        <p className="max-w-xl text-center text-2xl font-bold leading-snug text-foreground">
          {dilemma}
        </p>
      )}

      {/* Agent presence — no card boxes */}
      <div className="flex w-full max-w-md justify-around">
        <AgentCard
          name="The Optimizer"
          emoji="🧠"
          color="amber"
          isActive={speakerLabel === "The Optimizer"}
        />
        <AgentCard
          name="The Vibe-Check"
          emoji="✨"
          color="vibe"
          isActive={speakerLabel === "The Vibe-Check"}
        />
      </div>

      {/* Live audio bar visualizer */}
      <div className="flex w-full max-w-lg flex-col items-center gap-2">
        <BarVisualizer
          state={state}
          barCount={24}
          trackRef={audioTrack}
          style={{ width: "100%", height: 56 }}
        />
        <p className="font-mono text-xs uppercase tracking-widest text-white/30">
          {statusLabel[state] ?? state}
        </p>
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
          className={`flex items-center gap-2 rounded-full px-6 py-3 font-mono text-xs uppercase tracking-widest transition ${
            consensusSent
              ? "border border-white/10 text-white/25 cursor-default"
              : "border border-white/20 text-white/60 hover:border-amber hover:text-amber"
          }`}
        >
          <CheckCircle size={13} />
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
          className={`flex items-center gap-2 rounded-full px-5 py-2 font-mono text-xs uppercase tracking-widest transition ${
            isMicrophoneEnabled
              ? "border border-white/15 text-white/50 hover:border-white/30"
              : "border border-red-500/40 text-red-400/70 hover:border-red-400"
          }`}
        >
          {isMicrophoneEnabled ? <Mic size={12} /> : <MicOff size={12} />}
          {isMicrophoneEnabled ? "Mute" : "Unmute"}
        </button>
      )}
      <button
        type="button"
        onClick={onLeave}
        className="flex items-center gap-2 rounded-full border border-red-500/30 px-5 py-2 font-mono text-xs uppercase tracking-widest text-red-400/60 transition hover:border-red-400 hover:text-red-400"
      >
        <LogOut size={12} />
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
        className="flex items-center gap-2 rounded-full border border-white/15 px-3 py-2 font-mono text-xs uppercase tracking-widest text-white/40 transition hover:border-amber hover:text-amber"
      >
        <QrCode size={12} />
        Invite
      </button>
      {open && dataUrl && (
        <div className="absolute right-0 top-full z-50 mt-2 border border-white/10 bg-[#050505] p-4 shadow-2xl">
          <p className="mb-2 text-center font-mono text-xs uppercase tracking-widest text-white/30">Scan to join</p>
          <img src={dataUrl} alt="QR code" width={160} height={160} />
        </div>
      )}
    </div>
  );
}

function AgentCard({
  name,
  emoji,
  color,
  isActive,
}: {
  name: string;
  emoji: string;
  color: "amber" | "vibe";
  isActive: boolean;
}) {
  const dotColor = color === "amber" ? "bg-amber" : "bg-vibe";
  const glowShadow =
    color === "amber"
      ? "0 0 24px rgba(246,196,83,0.7)"
      : "0 0 24px rgba(244,114,182,0.7)";

  return (
    <div className="flex flex-col items-center gap-3">
      <span
        className="text-5xl transition-all duration-300"
        style={isActive ? { filter: `drop-shadow(${glowShadow})` } : undefined}
      >
        {emoji}
      </span>
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full transition-all duration-300 ${dotColor} ${isActive ? "animate-pulse opacity-100" : "opacity-20"}`}
        />
        <span className="font-mono text-xs uppercase tracking-widest text-white/40">{name}</span>
      </div>
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
    <div className="flex flex-col items-center gap-10 px-4 py-16">
      {dilemma && (
        <p className="max-w-xl text-center text-2xl font-bold leading-snug text-foreground">
          {dilemma}
        </p>
      )}

      <div className="w-full max-w-sm border border-white/10 p-5">
        <div className="mb-4 flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-white/30">
          <Users size={12} />
          In the room ({humans.length})
        </div>
        <ul className="flex flex-col gap-2">
          {humans.map((p) => {
            const isLocal = p.identity === room.localParticipant.identity;
            const label = p.identity.startsWith("host-")
              ? `Host${isLocal ? " (you)" : ""}`
              : isLocal
                ? `${p.identity} (you)`
                : p.identity;
            return (
              <li key={p.identity} className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-white/50">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
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
          className="flex items-center gap-2 rounded-full bg-amber px-8 py-4 font-semibold text-black transition hover:bg-amber/90 disabled:opacity-40"
        >
          {starting ? "Starting…" : !locationCtx ? "Getting location…" : "Start Debate"}
          <ArrowRight size={18} />
        </button>
      ) : (
        <p className="animate-pulse font-mono text-xs uppercase tracking-widest text-white/25">
          Waiting for host…
        </p>
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
        <p className="font-mono text-xs uppercase tracking-widest text-red-400/70">{error}</p>
      </main>
    );
  }

  if (!connectionDetails) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="animate-pulse font-mono text-xs uppercase tracking-widest text-white/25">
          Connecting to arena…
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-amber/70">The Decider — Live</p>
          <h1 className="mt-1 max-w-lg text-lg font-bold text-foreground leading-snug">
            {dilemma || roomName}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="flex items-center gap-2 rounded-full border border-white/15 px-3 py-2 font-mono text-xs uppercase tracking-widest text-white/40 transition hover:border-amber hover:text-amber"
          >
            <Copy size={12} />
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
