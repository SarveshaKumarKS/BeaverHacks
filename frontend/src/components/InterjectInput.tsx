"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Send, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSocketStore } from "@/store/socket-store";
import type { SessionStatus } from "@/store/socket-store";

// Browser SpeechRecognition API type shim
type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionEvent = {
  results: { [index: number]: { [index: number]: { transcript: string } }; length: number };
  resultIndex: number;
};

type SpeechRecognitionErrorEvent = { error: string };

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

function getPlaceholder(status: SessionStatus | undefined, listening: boolean): string {
  if (listening) return "Listening… speak now";
  switch (status) {
    case "awaiting_user_answer":
      return "Answer the agents' question…";
    case "user_interrupting":
      return "Agent is wrapping up, send to continue…";
    case "speaking":
      return "Break in — constraint, correction, or better idea…";
    default:
      return "Send a message to the agents…";
  }
}

export function InterjectInput({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [sttSupported, setSttSupported] = useState(false);
  const [sttError, setSttError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const interject = useSocketStore((state) => state.interject);
  const sessionStatus = useSocketStore((state) => state.session?.status);

  const isSpeaking = sessionStatus === "speaking";
  const isAwaiting = sessionStatus === "awaiting_user_answer";

  useEffect(() => {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSttSupported(!!SR);
  }, []);

  function startListening() {
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) return;
    setSttError(null);
    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setText(transcript);
    };
    recognition.onerror = (event) => {
      setSttError(event.error === "not-allowed" ? "Mic permission denied" : `Error: ${event.error}`);
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    recognition.start();
    setListening(true);
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (listening) stopListening();
    interject(sessionId, trimmed);
    setText("");
    setSttError(null);
  }

  return (
    <div className="sticky bottom-0 z-10 border-t border-white/10 bg-background/95 backdrop-blur">
      {sttError && <p className="px-4 pt-2 text-xs text-rose-400">{sttError}</p>}

      {/* Contextual hint strip */}
      {isAwaiting && (
        <div className="flex items-center gap-2 border-b border-sky-400/20 bg-sky-400/5 px-4 py-1.5 text-xs text-sky-300">
          <span className="animate-pulse">●</span>
          The agents are waiting for your answer
        </div>
      )}

      <form onSubmit={submit} className="flex gap-2 p-4">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={getPlaceholder(sessionStatus, listening)}
          className={cn(
            "min-w-0 flex-1 rounded-md border bg-white/5 px-4 py-3 text-white outline-none transition focus:border-amber",
            listening ? "border-rose-400/70 bg-rose-400/5" : "border-white/10",
            isAwaiting && !listening && "border-sky-400/40 focus:border-sky-400"
          )}
        />

        {sttSupported && (
          <button
            type="button"
            title={listening ? "Stop recording" : "Speak your message"}
            onClick={listening ? stopListening : startListening}
            className={cn(
              "relative rounded-md border px-4 transition",
              listening
                ? "border-rose-400 text-rose-400 hover:border-rose-300"
                : "border-white/10 text-white/60 hover:border-white/30 hover:text-white/90"
            )}
          >
            {listening ? <MicOff size={20} /> : <Mic size={20} />}
            {listening && (
              <span className="absolute -right-1 -top-1 h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" />
            )}
          </button>
        )}

        {/* Interrupt button – only shown while agents are actively speaking */}
        {isSpeaking && text.trim() && (
          <button
            type="submit"
            title="Break in now"
            className="flex items-center gap-1.5 rounded-md border border-amber bg-amber/10 px-4 text-sm font-semibold text-amber transition hover:bg-amber hover:text-black"
          >
            <Zap size={16} />
            Break in
          </button>
        )}

        {/* Default send button */}
        {(!isSpeaking || !text.trim()) && (
          <button
            type="submit"
            title={isAwaiting ? "Send answer" : "Send message"}
            className={cn(
              "rounded-md px-4 text-sm font-semibold text-black transition",
              isAwaiting
                ? "bg-sky-400 hover:bg-sky-300"
                : "bg-amber hover:bg-amber/90"
            )}
          >
            <Send size={20} />
          </button>
        )}
      </form>
    </div>
  );
}
