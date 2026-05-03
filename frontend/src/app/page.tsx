"use client";

import { FormEvent, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { ArrowRight, Link2 } from "lucide-react";

export default function HostLobby() {
  const router = useRouter();
  const [dilemma, setDilemma] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [qr, setQr] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = useMemo(() => dilemma.trim().length > 0, [dilemma]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError("");
    try {
      const roomName = crypto.randomUUID();
      const identity = `host-${Date.now()}`;

      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, identity, dilemma: dilemma.trim() }),
      });

      if (!res.ok) throw new Error(await res.text());

      const { token, wsUrl } = (await res.json()) as {
        token: string;
        wsUrl: string;
        roomName: string;
      };

      // Cache token so the room page can connect without a second round-trip
      sessionStorage.setItem(`lk-token-${roomName}`, token);
      sessionStorage.setItem(`lk-wsurl-${roomName}`, wsUrl);

      const url = `${window.location.origin}/room/${roomName}`;
      setShareUrl(url);
      setQr(await QRCode.toDataURL(url, { margin: 1, width: 220 }));

      router.push(`/room/${roomName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

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

          {shareUrl && (
            <div className="mt-5 rounded-md border border-white/10 bg-white/5 p-4">
              <div className="flex items-center gap-2 text-sm text-white/70">
                <Link2 size={16} />
                <span className="truncate">{shareUrl}</span>
              </div>
              {qr && (
                <Image
                  src={qr}
                  alt="Room QR code"
                  width={220}
                  height={220}
                  unoptimized
                  className="mt-4 rounded-md bg-white p-2"
                />
              )}
            </div>
          )}
        </form>
      </section>
    </main>
  );
}
