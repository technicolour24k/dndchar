import type { OverworldErrorCode } from '$lib/types/overworld';

// An error whose message is safe to show to the user ("Only a DM can change this pin.").
// `not_found` also covers "exists but you cannot see it", so a failed check never reveals which.
export class OverworldError extends Error {
  code: OverworldErrorCode;
  constructor(code: OverworldErrorCode, message: string) {
    super(message);
    this.name = 'OverworldError';
    this.code = code;
  }
}
