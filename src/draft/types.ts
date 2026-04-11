export interface Prospect {
  rank: number;       // 1-500, used as ID
  name: string;
  pos: string;        // QB, RB, WR, TE, OT, OG, C, EDGE, DE, DT, LB, CB, S, K, P, LS
  school: string;
}

export interface TeamCapInfo {
  capUsed: number;           // Total cap charges (top-51 + dead money) in thousands
  capSpace: number;          // Remaining cap room in thousands
  deadMoney: number;         // Dead money from trades in thousands
  projectedRookieCap: number; // Projected cap from undrafted picks this team owns, in thousands
  effectiveCapSpace: number; // Cap space after projecting all owned rookie slots, in thousands
}

export interface Team {
  name: string;       // "Las Vegas Raiders"
  city: string;
  abbr: string;       // "LV"
  color: number;      // hex color for embeds
}

export interface PickSlot {
  overall: number;    // 1-224
  round: number;      // 1-7
  roundPick: number;  // 1-32
  originalTeam: string;
  currentTeam: string;
  isTraded: boolean;
}

export type DraftStatus = 'idle' | 'active' | 'paused' | 'complete';

export interface CompletedPick {
  overall: number;
  round: number;
  roundPick: number;
  team: string;
  prospectRank: number;
  prospectName: string;
  pos: string;
  school: string;
  userId: string | null;   // null = CPU
  autoPicked: boolean;
  pickedAt: number;        // Date.now()
}

export type TradeAnnouncement = 'private' | 'public' | 'intrigue' | 'insider';

export interface DraftConfig {
  channelId: string | null;
  timerSeconds: number | null;
  autoPick: boolean;
  rounds: number;   // how many rounds to simulate (default 7)
  allowPlayerTrades: boolean; // whether players can be included in trades (default true)
  tradeAnnouncement: TradeAnnouncement; // how trade proposals are announced (default 'intrigue')
  enforceSalaryCap: boolean; // whether to validate trades against salary cap (default false)
}

export interface FuturePickRight {
  id: string;           // e.g. "2027-R1-LV"
  year: number;         // 2027, 2028
  round: number;        // 1-7
  originalTeam: string; // team the pick originally belongs to
  currentTeam: string;  // team that currently holds it
}

export interface PendingTrade {
  id: string;
  proposerUserId: string;
  proposerTeam: string;
  receiverUserId: string;
  receiverTeam: string;
  offeredOveralls: number[];       // proposer gives these current-draft picks
  requestedOveralls: number[];     // proposer receives these current-draft picks
  offeredPlayers: string[];        // proposer gives these players (by name)
  requestedPlayers: string[];      // proposer receives these players (by name)
  offeredFuturePicks: string[];    // FuturePickRight ids proposer gives
  requestedFuturePicks: string[];  // FuturePickRight ids proposer receives
  createdAt: number;
  expiresAt: number;
}

export type TradeCancelReason = 'declined' | 'expired' | 'superseded' | 'picked';

export interface CancelledTrade extends PendingTrade {
  cancelReason: TradeCancelReason;
  cancelledAt: number;
}

export interface DraftState {
  schemaVersion: number;
  status: DraftStatus;
  config: DraftConfig;
  assignments: Record<string, string>;     // teamAbbr -> primary GM userId
  coManagers: Record<string, string[]>;    // teamAbbr -> co-manager userIds
  schedule: PickSlot[];
  currentPickIndex: number;
  picks: CompletedPick[];
  availableRanks: number[];                // prospect ranks still available
  timerExpiresAt: number | null;           // Date.now() ms, for restart resilience
  pendingTrades: PendingTrade[];
  tradeHistory: PendingTrade[];            // completed trades (for admin undo)
  cancelledTrades: CancelledTrade[];      // declined, expired, or invalidated trades
  playerOwnership: Record<string, string>; // playerName (lowercase) -> teamAbbr overrides
  futurePickRights: FuturePickRight[];     // tradeable future-year picks
}

export interface BoardData {
  customBoards: Record<string, number[]>;      // teamAbbr -> ordered prospect ranks (GM-submitted)
  positionPriority: Record<string, string[]>;  // teamAbbr -> ordered position list for autopick
  strategyNotes: Record<string, string[]>;     // teamAbbr -> last N board-ai instructions for LLM memory
}

export interface PickResult {
  success: boolean;
  error?: string;
  pick?: CompletedPick;
  completionEmbeds?: import('discord.js').EmbedBuilder[];  // set when this pick ends the draft
}

export interface RegisterResult {
  success: boolean;
  error?: string;
}
