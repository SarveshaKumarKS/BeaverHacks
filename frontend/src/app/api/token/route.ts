import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { NextResponse } from "next/server";

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

// POST /api/token — creates a room (with dilemma metadata) and returns a JWT
export async function POST(request: Request) {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json({ error: "LiveKit env vars not configured" }, { status: 500 });
  }

  const { roomName, identity, dilemma } = (await request.json()) as {
    roomName: string;
    identity: string;
    dilemma?: string;
  };

  if (!roomName || !identity) {
    return NextResponse.json({ error: "roomName and identity are required" }, { status: 400 });
  }

  // Create the room and store the dilemma as metadata.
  // The agent worker reads ctx.room.metadata to seed the debate.
  if (dilemma) {
    const roomSvc = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    try {
      await roomSvc.createRoom({ name: roomName, metadata: dilemma });
    } catch {
      // Room may already exist — that's fine, continue.
    }
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: "1h",
  });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  const token = await at.toJwt();
  return NextResponse.json({ token, wsUrl: LIVEKIT_URL, roomName });
}

// GET /api/token?room=<name>&identity=<id> — guest participant token
export async function GET(request: Request) {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json({ error: "LiveKit env vars not configured" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const roomName = searchParams.get("room");
  const identity = searchParams.get("identity") ?? `guest-${Date.now()}`;

  if (!roomName) {
    return NextResponse.json({ error: "room param required" }, { status: 400 });
  }

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    ttl: "1h",
  });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

  const token = await at.toJwt();
  return NextResponse.json({ token, wsUrl: LIVEKIT_URL, roomName });
}
