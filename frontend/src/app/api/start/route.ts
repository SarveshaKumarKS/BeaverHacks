import { RoomServiceClient } from "livekit-server-sdk";
import { NextResponse } from "next/server";

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

export async function POST(request: Request) {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return NextResponse.json({ error: "LiveKit env vars not configured" }, { status: 500 });
  }

  const { roomName, dilemma, participants = [], location = "" } = (await request.json()) as {
    roomName: string;
    dilemma: string;
    participants?: string[];
    location?: string;
  };

  if (!roomName) {
    return NextResponse.json({ error: "roomName required" }, { status: 400 });
  }

  const roomSvc = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  await roomSvc.updateRoomMetadata(
    roomName,
    JSON.stringify({ dilemma: dilemma ?? "", status: "started", participants, location }),
  );

  return NextResponse.json({ ok: true });
}
