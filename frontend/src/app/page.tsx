"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
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

  // Resolved as early as possible so it's ready before the host clicks Start Debate
  const [locationCtx, setLocationCtx] = useState("");

  useEffect(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const localTime = new Date().toLocaleString("en-US", {
      timeZone: timezone,
      weekday: "long",
      hour: "numeric",
      minute: "numeric",
      hour12: true,
    });

    async function resolveFromIP() {
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
      resolveFromIP();
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
          resolveFromIP();
        }
      },
      () => resolveFromIP(),
      { timeout: 5000 },
    );
  }, []);

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
      sessionStorage.setItem(`lk-dilemma-${name}`, dilemma.trim());
      sessionStorage.setItem(`lk-location-${name}`, locationCtx);

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
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-10 px-6 py-10">
        <div className="w-full">
          <p className="font-mono text-xs uppercase tracking-widest text-white/30">The Decider</p>
          <h2 className="mt-3 text-3xl font-bold text-foreground">Arena ready.</h2>
          <p className="mt-2 text-sm text-white/40">
            Share the QR code so others can join, then enter when ready.
          </p>
        </div>

        {qr && (
          <Image
            src={qr}
            alt="Room QR code"
            width={280}
            height={280}
            unoptimized
            className="border border-white/10"
          />
        )}

        <button
          type="button"
          onClick={copyLink}
          className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-white/30 transition hover:text-amber"
        >
          <Link2 size={12} />
          {copied ? "Copied!" : shareUrl}
        </button>

        <button
          type="button"
          onClick={() => router.push(`/room/${roomName}`)}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-amber px-6 py-4 text-base font-semibold text-black transition hover:bg-amber/90"
        >
          Enter Room
          <ArrowRight size={18} />
        </button>
      </main>
    );
  }

  // ── Landing / form view ─────────────────────────────────────────────────────
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center px-6 py-12">
      <section className="grid gap-12 md:grid-cols-[1fr_1fr] md:items-start md:pt-16">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-amber">The Consensus Duo</p>
          <h1 className="mt-4 text-6xl font-bold leading-none text-foreground md:text-8xl">
            The<br />Decider
          </h1>
          <p className="mt-6 max-w-sm text-sm leading-7 text-white/45">
            Two AI voices argue your dilemma in real-time. Native audio,
            zero latency — just speak and let them fight it out.
          </p>
        </div>

        <form onSubmit={submit} className="border border-white/10 p-6">
          <label className="block font-mono text-xs uppercase tracking-widest text-white/30" htmlFor="dilemma">
            What&apos;s the dilemma?
          </label>
          <textarea
            id="dilemma"
            value={dilemma}
            onChange={(e) => setDilemma(e.target.value)}
            placeholder="Type your dilemma…"
            rows={4}
            className="mt-4 w-full resize-none border-0 bg-transparent text-4xl font-bold leading-snug text-foreground outline-none placeholder:text-white/15 focus:outline-none md:text-5xl"
          />

          <div className="mt-6 border-t border-white/10 pt-5">
            <label className="block font-mono text-xs uppercase tracking-widest text-white/30">
              Who&apos;s joining? <span className="text-white/15">(optional)</span>
            </label>
            <p className="mt-1 font-mono text-xs text-white/20">
              Agents will address participants by name.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addParticipant())}
                placeholder="e.g. Alice"
                className="flex-1 border border-white/10 bg-transparent px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-white/20 focus:border-amber"
              />
              <button
                type="button"
                onClick={addParticipant}
                className="flex items-center gap-1 rounded-full border border-white/15 px-4 py-2 font-mono text-xs uppercase tracking-widest text-white/40 transition hover:border-amber hover:text-amber"
              >
                <Plus size={12} />
                Add
              </button>
            </div>
            {participants.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {participants.map((name) => (
                  <span
                    key={name}
                    className="flex items-center gap-1 rounded-full border border-amber/30 px-3 py-1 font-mono text-xs uppercase tracking-widest text-amber"
                  >
                    {name}
                    <button type="button" onClick={() => removeParticipant(name)} className="ml-1">
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {locationCtx && (
            <p className="mt-4 font-mono text-xs uppercase tracking-widest text-white/20">
              {locationCtx.split(",").slice(1).join(",").trim() || locationCtx}
            </p>
          )}

          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={!canSubmit || loading}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-full bg-amber px-5 py-3 font-semibold text-black transition hover:bg-amber/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? "Spinning up…" : "Start the Debate"}
            <ArrowRight size={16} />
          </button>
        </form>
      </section>
    </main>
  );
}
