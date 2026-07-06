import { ChatInputCommandInteraction, AutocompleteInteraction } from 'discord.js';
import { DraftManager } from '../discord/DraftManager';

import * as draftCmd   from './draft';
import * as pickCmd    from './pick';
import * as autopickCmd from './autopick';
import * as boardCmd   from './board';
import * as statusCmd  from './status';
import * as rosterCmd  from './roster';
import * as tradeCmd   from './trade';
import * as helpCmd      from './help';
import * as inventoryCmd from './inventory';
import * as upcomingCmd  from './upcoming';
import * as recapCmd     from './recap';
import * as tradeHistoryCmd from './trade-history';
import * as tradeAiCmd      from './trade-ai';
import * as boardAiCmd      from './board-ai';
import * as rumorCmd        from './rumor';
import * as leakCmd         from './leak';

interface Command {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction, manager: DraftManager): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction, manager: DraftManager): Promise<void>;
}

export const commands: Command[] = [
  draftCmd,
  pickCmd,
  autopickCmd,
  boardCmd,
  statusCmd,
  rosterCmd,
  tradeCmd,
  helpCmd,
  inventoryCmd,
  upcomingCmd,
  recapCmd,
  tradeHistoryCmd,
  tradeAiCmd,
  boardAiCmd,
  rumorCmd,
  leakCmd,
];

export const commandMap = new Map<string, Command>(
  commands.map(cmd => [cmd.data.name, cmd])
);
