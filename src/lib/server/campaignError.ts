// An error whose message is safe to show to the user ("This campaign already has a co-DM.").
// Anything else thrown from a campaign action is treated as unexpected: logged, not echoed.
export class CampaignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignError';
  }
}
