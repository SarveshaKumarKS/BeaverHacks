"use client";

import { FormEvent, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { ArrowRight, Link2, Plus, X } from "lucide-react";

export default function HostLobby() {
  const router = useRouter();
  const [dilemma, setDilemma] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Participant names (people sharing the host's mic)
  const [participants, setParticipants] = useState<string[]>([]);
  const [nameInput, setNameInput] = useState("");

  // Set once the room is created — triggers lobby view
  const [roomName, setRoomName] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [qr, setQr] = useState("");

  const canSubmit = useMemo(() => dilemma.trim().length > 0, [dilemma]);
  const inLobby = shareUrl !== "";

  function addParticipant() {
    const trimmed = nameInput.trim();
    if (!trimmed || participants.includes(trimmed)) return;
    setParticipants((prev) => [...prev, trimmed]);
    setNameInput("");
  }

  function removeParticipant(name: string) {
    setParticipants((prev) => prev.filter((n) => n !== name));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError("");
    try {
      const name = crypto.randomUUID();
      const identity = `host-${Date.now()}`;

      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName: name, identity, dilemma: dilemma.trim() }),
      });

      if (!res.ok) throw new Error(await res.text());

      const { token, wsUrl } = (await res.json()) as {
        token: string;
        wsUrl: string;
        roomName: string;
      };

      sessionStorage.setItem(`lk-token-${name}`, token);
      sessionStorage.setItem(`lk-wsurl-${name}`, wsUrl);
      sessionStorage.setItem(`lk-participants-${name}`, JSON.stringify(participants));

      const url = `${window.location.origin}/room/${name}`;
      const dataUrl = await QRCode.toDataURL(url, {
        margin: 2,
        width: 320,
        color: { dark: "#ffffff", light: "#0d1117" },
      });

      setRoomName(name);
      setShareUrl(url);
      setQr(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function copyLink() {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  // ── Lobby view ──────────────────────────────────────────────────────────────
  if (inLobby) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-8 px-6 py-10">
        <div className="text-center">
          <p className="text-xs uppercase tracking-[0.26em] text-white/40">The Decider</p>
          <h2 className="mt-2 text-2xl font-bold text-white">Arena ready</h2>
          <p className="mt-2 text-white/50">
            Share the QR code so others can join, then enter when ready.
          </p>
        </div>

        {qr && (
          <Image
            src={qr}
            alt="Room QR code"
            width={320}
            height={320}
            unoptimized
            className="rounded-2xl"
          />
        )}

        <button
          type="button"
          onClick={copyLink}
          className="flex items-center gap-2 text-sm text-white/50 transition hover:text-white/80"
        >
          <Link2 size={14} />
          {copied ? "Copied!" : shareUrl}
        </button>

        <button
          type="button"
          onClick={() => router.push(`/room/${roomName}`)}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-amber-400 px-6 py-4 text-lg font-semibold text-black transition hover:bg-amber-300"
        >
          Enter Room
          <ArrowRight size={20} />
        </button>
      </main>
    );
  }

  // ── Landing / form view ─────────────────────────────────────────────────────
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-10">
      <section className="grid gap-8 md:grid-cols-[1.1fr_0.9fr] md:items-center">
        <div>
          <p className="text-sm uppercase tracking-[0.26em] text-amber">The Consensus Duo</p>
          <h1 className="mt-3 text-5xl font-bold leading-tight text-white md:text-7xl">
            The Decider
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-white/65">
            Two AI podcast hosts argue your dilemma in real-time voice. Native audio,
            zero latency — just speak and let them fight it out.
          </p>
        </div>

        <form onSubmit={submit} className="rounded-lg border border-white/10 bg-panel p-5 shadow-2xl">
          <label className="block text-sm font-medium text-white/70" htmlFor="dilemma">
            What&apos;s the dilemma?
          </label>
          <textarea
            id="dilemma"
            value={dilemma}
            onChange={(e) => setDilemma(e.target.value)}
            placeholder="What should our team build, eat, ship, buy, or avoid?"
            rows={5}
            className="mt-2 w-full resize-none rounded-md border border-white/10 bg-white/5 px-4 py-3 outline-none transition focus:border-amber"
          />
          {/* Participant names */}
          <div className="mt-4">
            <label className="block text-sm font-medium text-white/70">
              Who&apos;s joining? <span className="text-white/30">(optional)</span>
            </label>
            <p className="mt-1 text-xs text-white/40">
              Add names for everyone sharing the mic — agents will address them by name.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addParticipant())}
                placeholder="e.g. Alice"
                className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none transition focus:border-amber"
              />
              <button
                type="button"
                onClick={addParticipant}
                className="flex items-center gap-1 rounded-md border border-white/10 px-3 py-2 text-sm text-white/60 transition hover:border-amber hover:text-white"
              >
                <Plus size={14} />
                Add
              </button>
            </div>
            {participants.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {participants.map((name) => (
                  <span
                    key={name}
                    className="flex items-center gap-1 rounded-full bg-amber/20 px-3 py-1 text-xs font-semibold text-amber"
                  >
                    {name}
                    <button type="button" onClick={() => removeParticipant(name)}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
          <button
            type="submit"
            disabled={!canSubmit || loading}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-amber px-4 py-3 font-semibold text-black transition hover:bg-amber/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Spinning up the arena…" : "Start the Debate"}
            <ArrowRight size={18} />
          </button>
        </form>
      </section>
    </main>
  );
}
