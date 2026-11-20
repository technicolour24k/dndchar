export type Effect = {
  id: string;
  targetId: string;
  name: string;
  expiresAtRound: number | null;
};
