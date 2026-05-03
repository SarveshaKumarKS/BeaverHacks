"use client";

import { useCallback, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Browser speechSynthesis voice configs
// ---------------------------------------------------------------------------

type AgentConfig = { rate: number; pitch: number; preferFemale: boolean };

const BROWSER_CONFIG: Record<string, AgentConfig> = {
  Optimizer: { rate: 1.18, pitch: 0.65, preferFemale: false },
  "Vibe-Check": { rate: 0.92, pitch: 1.45, preferFemale: true },
};

function pickVoice(preferFemale: boolean): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const en = voices.filter((v) => v.lang.startsWith("en"));
  const gendered = en.filter((v) =>
    preferFemale
      ? /female|woman|girl|samantha|victoria|karen|moira|tessa|fiona/i.test(v.name)
      : /male|man|daniel|alex|fred|thomas|rishi/i.test(v.name)
  );
  return gendered[0] ?? en[0] ?? voices[0];
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function cleanForTTS(text: string): string {
  return text
    .replace(/\[INTERROGATE:[^\]]*\]/gi, "")
    .replace(/\[CONSENSUS_REACHED\]:/gi, "Decision reached:")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Browser TTS speaker (returns a Promise that resolves when done)
// ---------------------------------------------------------------------------

function speakBrowser(text: string, agent: string): Promise<void> {
  return new Promise((resolve) => {
    const config = BROWSER_CONFIG[agent];
    if (!config || typeof window === "undefined" || !window.speechSynthesis) {
      resolve();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = config.rate;
    utterance.pitch = config.pitch;
    utterance.volume = 1.0;
    const voice = pickVoice(config.preferFemale);
    if (voice) utterance.voice = voice;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    window.speechSynthesis.speak(utterance);
  });
}

// ---------------------------------------------------------------------------
// Provider TTS speaker (POST /tts?agent=…&text=…)
// ---------------------------------------------------------------------------

async function speakProvider(
  text: string,
  agent: string,
  endpoint: string,
  currentAudioRef: React.MutableRefObject<HTMLAudioElement | null>
): Promise<void> {
  const url = `${endpoint}?agent=${encodeURIComponent(agent)}&text=${encodeURIComponent(text)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`TTS request failed: ${resp.status}`);
  const blob = await resp.blob();
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  currentAudioRef.current = audio;
  return new Promise((resolve) => {
    audio.onended = () => { URL.revokeObjectURL(audioUrl); currentAudioRef.current = null; resolve(); };
    audio.onerror = () => { URL.revokeObjectURL(audioUrl); currentAudioRef.current = null; resolve(); };
    audio.play().catch(() => { URL.revokeObjectURL(audioUrl); currentAudioRef.current = null; resolve(); });
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type UseTTSOptions = {
  messages: { speaker: string; text: string }[];
  sessionStatus: string;
  enabled: boolean;
  /** If set, use provider TTS at this base URL instead of browser speechSynthesis */
  ttsEndpoint?: string | null;
};

export function useTTS({ messages, sessionStatus, enabled, ttsEndpoint }: UseTTSOptions) {
  const spokenCountRef = useRef(0);

  type QueueItem = { text: string; agent: string };
  const queueRef = useRef<QueueItem[]>([]);
  const isPlayingRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  // ------------------------------------------------------------------
  // Cancel all queued and in-flight TTS immediately
  // ------------------------------------------------------------------
  const cancelAll = useCallback(() => {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    currentAudioRef.current?.pause();
    currentAudioRef.current = null;
    queueRef.current = [];
    isPlayingRef.current = false;
  }, []);

  // ------------------------------------------------------------------
  // Sequential queue processor
  // ------------------------------------------------------------------
  const processQueue = useCallback(async () => {
    if (isPlayingRef.current) return;
    isPlayingRef.current = true;

    while (queueRef.current.length > 0) {
      const item = queueRef.current.shift()!;
      if (!isPlayingRef.current) break; // was cancelled

      try {
        if (ttsEndpoint) {
          await speakProvider(item.text, item.agent, ttsEndpoint, currentAudioRef);
        } else {
          await speakBrowser(item.text, item.agent);
        }
      } catch {
        // skip failed items
      }
    }

    isPlayingRef.current = false;
  }, [ttsEndpoint]);

  const enqueue = useCallback(
    (text: string, agent: string) => {
      queueRef.current.push({ text, agent });
      void processQueue();
    },
    [processQueue]
  );

  // ------------------------------------------------------------------
  // Cancel speech immediately when the user interrupts mid-agent
  // ------------------------------------------------------------------
  useEffect(() => {
    if (sessionStatus === "user_interrupting") {
      cancelAll();
    }
  }, [sessionStatus, cancelAll]);

  // ------------------------------------------------------------------
  // Speak each new completed message as it lands in the transcript
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!enabled) return;

    const newMessages = messages.slice(spokenCountRef.current);
    if (!newMessages.length) return;
    spokenCountRef.current = messages.length;

    for (const msg of newMessages) {
      if (!BROWSER_CONFIG[msg.speaker]) continue; // skip System / User lines
      const clean = cleanForTTS(msg.text);
      if (clean) enqueue(clean, msg.speaker);
    }
  }, [messages, enabled, enqueue]);

  // ------------------------------------------------------------------
  // Cleanup on unmount
  // ------------------------------------------------------------------
  useEffect(() => {
    return cancelAll;
  }, [cancelAll]);
}
