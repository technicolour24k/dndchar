import { json } from '@sveltejs/kit';
import { sessions, socketsBySession, generateRoomCode, createSession } from '$vtt/store.js';

export async function POST() {
  const id = generateRoomCode(sessions);
  sessions.set(id, createSession(id));
  socketsBySession.set(id, new Set());
  return json({ sessionId: id });
}
