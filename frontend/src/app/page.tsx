"use client";

import { FormEvent, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { ArrowRight, Link2 } from "lucide-react";

export default function HostLobby() {
  const router = useRouter();
  const [dilemma, setDilemma] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Set once the room is created — triggers lobby view
  const [roomName, setRoomName] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [qr, setQr] = useState("");

  const canSubmit = useMemo(() => dilemma.trim().length > 0, [dilemma]);
  const inLobby = shareUrl !== "";

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
