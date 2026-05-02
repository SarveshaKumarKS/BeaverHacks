"use client";

import { create } from "zustand";
import { io, Socket } from "socket.io-client";
import { API_URL } from "@/lib/utils";

export type AgentName = "Optimizer" | "Vibe-Check";

export type TranscriptMessage = {
  speaker: string;
  text: string;
};

export type ActiveSession = {
  session_id: string;
  group_id: string;
  dilemma: string;
  known_constraints: Record<string, string>;
  current_turn: number;
  max_turns: number;
  transcript: TranscriptMessage[];
  social_debt_modifier: string;
  status: "active" | "paused_for_interrogation" | "consensus_reached";
  debt_balance: number;
  winner?: AgentName | null;
  final_decision?: string | null;
};

type ConsensusPayload = {
  final_decision: string;
  winner: AgentName;
  new_debt_balance: number;
};

type SocketState = {
  socket: Socket | null;
  session: ActiveSession | null;
  activeSpeaker: AgentName | null;
  missingFields: string[];
  streaming: Record<string, string>;
  consensus: ConsensusPayload | null;
  error: string | null;
  connect: () => Socket;
  createRoom: (groupId: string, initialDilemma: string) => Promise<string>;
  joinRoom: (sessionId: string, userName: string) => Promise<void>;
  interject: (sessionId: string, text: string) => void;
};

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  session: null,
  activeSpeaker: null,
  missingFields: [],
  streaming: {},
  consensus: null,
  error: null,

  connect: () => {
    const existing = get().socket;
    if (existing) return existing;

    const socket = io(API_URL, {
      transports: ["websocket"],
      autoConnect: true
    });

    socket.on("connect_error", (err) => set({ error: err.message }));
    socket.on("room_state_update", (session: ActiveSession) => {
      set({ session, streaming: {}, error: null });
    });
    socket.on("agent_typing", ({ speaker }: { speaker: AgentName }) => {
      set({ activeSpeaker: speaker });
    });
    socket.on("message_chunk", ({ speaker, chunk }: { speaker: string; chunk: string }) => {
      set((state) => ({
        streaming: {
          ...state.streaming,
          [speaker]: `${state.streaming[speaker] ?? ""}${chunk}`
        },
        activeSpeaker: speaker === "Optimizer" || speaker === "Vibe-Check" ? speaker : state.activeSpeaker
      }));
    });
    socket.on("interrogation_triggered", ({ missing_fields }: { missing_fields: string[] }) => {
      set({ missingFields: missing_fields });
    });
    socket.on("consensus_reached", (payload: ConsensusPayload) => {
      set({ consensus: payload, missingFields: [], activeSpeaker: null });
    });

    set({ socket });
    return socket;
  },

  createRoom: (groupId, initialDilemma) =>
    new Promise((resolve, reject) => {
      const socket = get().connect();
      socket.emit("create_room", { group_id: groupId, initial_dilemma: initialDilemma }, (response: { session_id?: string; error?: string }) => {
        if (response?.session_id) resolve(response.session_id);
        else reject(new Error(response?.error ?? "Unable to create room"));
      });
    }),

  joinRoom: (sessionId, userName) =>
    new Promise((resolve, reject) => {
      const socket = get().connect();
      socket.emit("join_room", { session_id: sessionId, user_name: userName }, (response: { ok: boolean; error?: string }) => {
        if (response?.ok) resolve();
        else reject(new Error(response?.error ?? "Unable to join room"));
      });
    }),

  interject: (sessionId, text) => {
    const socket = get().connect();
    socket.emit("user_interjection", { session_id: sessionId, text });
    set({ missingFields: [], consensus: null });
  }
}));

