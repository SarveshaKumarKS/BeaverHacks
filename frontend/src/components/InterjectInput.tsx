"use client";

import { FormEvent, useState } from "react";
import { Mic, Send } from "lucide-react";
import { useSocketStore } from "@/store/socket-store";

export function InterjectInput({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const interject = useSocketStore((state) => state.interject);

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    interject(sessionId, trimmed);
    setText("");
  }

  return (
    <form onSubmit={submit} className="sticky bottom-0 z-10 flex gap-2 border-t border-white/10 bg-background/95 p-4 backdrop-blur">
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Interrupt with a constraint, correction, or better idea..."
        className="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-4 py-3 text-white outline-none transition focus:border-amber"
      />
      <button type="button" title="Voice input placeholder" className="rounded-md border border-white/10 px-4 text-white/50" disabled>
        <Mic size={20} />
      </button>
      <button type="submit" title="Send interjection" className="rounded-md bg-amber px-4 text-sm font-semibold text-black transition hover:bg-amber/90">
        <Send size={20} />
      </button>
    </form>
  );
}

