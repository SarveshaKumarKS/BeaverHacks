"use client";

import { FormEvent, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { ArrowRight, DoorOpen, Link2 } from "lucide-react";
import { useSocketStore } from "@/store/socket-store";

export default function HostLobby() {
  const router = useRouter();
  const createRoom = useSocketStore((state) => state.createRoom);
  const error = useSocketStore((state) => state.error);
  const [groupId, setGroupId] = useState("beaverhacks");
  const [dilemma, setDilemma] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [createdSessionId, setCreatedSessionId] = useState("");
  const [qr, setQr] = useState("");
  const [loading, setLoading] = useState(false);

  const canSubmit = useMemo(() => groupId.trim() && dilemma.trim(), [groupId, dilemma]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    try {
      const sessionId = await createRoom(groupId.trim(), dilemma.trim());
      const url = `${window.location.origin}/room/${sessionId}`;
      setCreatedSessionId(sessionId);
      setShareUrl(url);
      setQr(await QRCode.toDataURL(url, { margin: 1, width: 220 }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-10">
      <section className="grid gap-8 md:grid-cols-[1.1fr_0.9fr] md:items-center">
        <div>
          <p className="text-sm uppercase tracking-[0.26em] text-amber">The Consensus Duo</p>
          <h1 className="mt-3 text-5xl font-bold leading-tight text-white md:text-7xl">The Decider</h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-white/65">
            Two agents argue the group out of indecision, interrogate missing constraints, and force a call before the room dissolves into committee energy.
          </p>
        </div>
        <form onSubmit={submit} className="rounded-lg border border-white/10 bg-panel p-5 shadow-2xl">
          <label className="block text-sm font-medium text-white/70" htmlFor="group-id">
            Group ID
          </label>
          <input
            id="group-id"
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            className="mt-2 w-full rounded-md border border-white/10 bg-white/5 px-4 py-3 outline-none transition focus:border-amber"
          />
          <label className="mt-5 block text-sm font-medium text-white/70" htmlFor="dilemma">
            Dilemma
          </label>
          <textarea
            id="dilemma"
            value={dilemma}
            onChange={(event) => setDilemma(event.target.value)}
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
            {loading ? "Creating..." : "Create Room"}
            <ArrowRight size={18} />
          </button>
          {shareUrl && (
            <div className="mt-5 rounded-md border border-white/10 bg-white/5 p-4">
              <div className="flex items-center gap-2 text-sm text-white/70">
                <Link2 size={16} />
                <span className="truncate">{shareUrl}</span>
              </div>
              {qr && <Image src={qr} alt="Room QR code" width={220} height={220} unoptimized className="mt-4 rounded-md bg-white p-2" />}
              <button
                type="button"
                onClick={() => router.push(`/room/${createdSessionId}`)}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-md border border-amber px-4 py-2 text-sm font-semibold text-amber transition hover:bg-amber hover:text-black"
              >
                <DoorOpen size={16} />
                Enter Arena
              </button>
            </div>
          )}
        </form>
      </section>
    </main>
  );
}
