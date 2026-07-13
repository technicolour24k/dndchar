import { json } from '@sveltejs/kit';
import { getTokenLibraryIndex } from '$vtt/tokenLibrary.js';

export function GET() {
  return json({ tokens: getTokenLibraryIndex() });
}
