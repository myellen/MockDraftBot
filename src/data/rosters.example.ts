export interface RosterPlayer {
  name: string;
  pos: string;
  number: string | null;
}

// Replace with current NFL rosters (can be generated via scripts/generate-rosters.ts using ESPN API)
export const ROSTERS: Record<string, RosterPlayer[]> = {
  LV: [
    { name: "Aidan O'Connell", pos: "QB", number: "12" },
    { name: "Davante Adams", pos: "WR", number: "17" },
    { name: "Josh Jacobs", pos: "RB", number: "8" },
    // ... full roster
  ],
  NYJ: [
    { name: "Aaron Rodgers", pos: "QB", number: "8" },
    { name: "Garrett Wilson", pos: "WR", number: "5" },
    // ... full roster
  ],
  // ... all 32 teams
};
