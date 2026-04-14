// Frontend type definitions mirroring engine types

export type DraftStatus = 'idle' | 'active' | 'paused' | 'complete';
export type TradeAnnouncement = 'private' | 'public' | 'intrigue' | 'insider';

export interface DraftConfig {
  channelId: string | null;
  timerSeconds: number | null;
  autoPick: boolean;
  rounds: number;
  allowPlayerTrades: boolean;
  tradeAnnouncement: TradeAnnouncement;
  enforceSalaryCap: boolean;
  cpuTrading: boolean;
  simulationMode: boolean;
  gmExtraResearch: boolean;
}

export interface PickSlot {
  overall: number;
  round: number;
  roundPick: number;
  originalTeam: string;
  currentTeam: string;
  isTraded: boolean;
}

export interface CompletedPick {
  overall: number;
  round: number;
  roundPick: number;
  team: string;
  prospectRank: number;
  prospectName: string;
  pos: string;
  school: string;
  userId: string | null;
  autoPicked: boolean;
  pickedAt: number;
}

export interface PendingTrade {
  id: string;
  proposerUserId: string;
  proposerTeam: string;
  receiverUserId: string;
  receiverTeam: string;
  offeredOveralls: number[];
  requestedOveralls: number[];
  offeredPlayers: string[];
  requestedPlayers: string[];
  offeredFuturePicks: string[];
  requestedFuturePicks: string[];
  createdAt: number;
  expiresAt: number;
}

export interface CancelledTrade extends PendingTrade {
  cancelReason: string;
  cancelledAt: number;
}

export interface FuturePickRight {
  id: string;
  year: number;
  round: number;
  originalTeam: string;
  currentTeam: string;
}

export interface Prospect {
  rank: number;
  name: string;
  pos: string;
  school: string;
}

export interface DraftState {
  schemaVersion: number;
  status: DraftStatus;
  config: DraftConfig;
  assignments: Record<string, string>;
  coManagers: Record<string, string[]>;
  schedule: PickSlot[];
  currentPickIndex: number;
  picks: CompletedPick[];
  availableRanks: number[];
  timerExpiresAt: number | null;
  pendingTrades: PendingTrade[];
  tradeHistory: PendingTrade[];
  cancelledTrades: CancelledTrade[];
  playerOwnership: Record<string, string>;
  futurePickRights: FuturePickRight[];
}

export interface Team {
  name: string;
  city: string;
  abbr: string;
  color: number;
}

export interface CPUOffer {
  id: string;
  proposerTeam: string;
  receiverTeam: string;
  offeredOveralls: number[];
  requestedOveralls: number[];
  offeredFuturePicks: string[];
  requestedFuturePicks: string[];
  offeredPlayers: string[];
  requestedPlayers: string[];
  pitch: string;
  createdAt: number;
  isCounter: boolean;
  originalOfferId?: string;
}

export interface InsiderTweet {
  name: string;
  handle: string;
  avatar: string;
  tweet: string;
}

// Social feed item types
export type FeedItemType =
  | 'insider-tweet'
  | 'pick-made'
  | 'trade-executed'
  | 'trade-chatter'
  | 'trade-cancelled'
  | 'cpu-offer'
  | 'round-change';

export interface FeedItem {
  id: string;
  type: FeedItemType;
  timestamp: number;
  data: any;
}

// Helper to convert engine team color (0xRRGGBB number) to CSS hex
export function teamColorToCSS(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}
