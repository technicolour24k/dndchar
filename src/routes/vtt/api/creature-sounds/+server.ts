import { json } from '@sveltejs/kit';
import { getCreatureSoundFolders } from '$vtt/creatureSoundLibrary.js';

export function GET() {
  return json({ folders: getCreatureSoundFolders() });
}
