import { json } from '@sveltejs/kit';

export function GET() {
  return json({
    ok: true,
    transport: 'socket.io',
    note: 'Socket.IO client plumbing is installed. Attach a Socket.IO server around the adapter-node handler when live rooms are enabled.'
  });
}
