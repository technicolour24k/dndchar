import { json } from '@sveltejs/kit';
import { getMusicLibraryIndex } from '$vtt/musicLibrary.js';

export function GET() {
  return json({ tracks: getMusicLibraryIndex() });
}
