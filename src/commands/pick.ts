import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, EmbedBuilder } from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { TEAMS } from '../data/teams';
import { ordinal } from '../utils/ordinal';

export const data = new SlashCommandBuilder()
  .setName('pick')
  .setDescription('Make your draft pick when your team is on the clock')
  .addStringOption(opt => opt
    .setName('position')
    .setDescription('Filter by position (default: All)')
    .setRequired(true)
    .addChoices(
      { name: 'All',  value: 'ALL'  },
      { name: 'QB',   value: 'QB'   },
      { name: 'RB',   value: 'RB'   },
      { name: 'WR',   value: 'WR'   },
      { name: 'TE',   value: 'TE'   },
      { name: 'OT',   value: 'OT'   },
      { name: 'OG',   value: 'OG'   },
      { name: 'C',    value: 'C'    },
      { name: 'EDGE', value: 'EDGE' },
      { name: 'DE',   value: 'DE'   },
      { name: 'DT',   value: 'DT'   },
      { name: 'LB',   value: 'LB'   },
      { name: 'CB',   value: 'CB'   },
      { name: 'S',    value: 'S'    },
      { name: 'K',    value: 'K'    },
      { name: 'P',    value: 'P'    },
    )
  )
  .addStringOption(opt => opt
    .setName('player')
    .setDescription('Player name (start typing to search)')
    .setRequired(true)
    .setAutocomplete(true)
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const rankStr = interaction.options.getString('player', true);
  const rank = parseInt(rankStr, 10);

  if (isNaN(rank)) {
    await interaction.reply({ content: '❌ Invalid player selection. Use the autocomplete to choose a player.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const result = await manager.makePick(interaction.user.id, rank);

  if (!result.success) {
    await interaction.editReply(`❌ ${result.error}`);
    return;
  }

  const pick = result.pick!;
  const team = TEAMS[pick.team];
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(team?.color ?? 0xFFB612)
        .setTitle(`With the ${ordinal(pick.overall)} pick in the NFL draft, the ${team?.name ?? pick.team} select:`)
        .setDescription(`**${pick.prospectName}** (${pick.pos}, ${pick.school})\nRound ${pick.round}, Pick ${pick.roundPick} · Overall #${pick.overall}`)
    ]
  });

  // Announce who is now on the clock
  const nextSlot = manager.getCurrentSlot();
  if (nextSlot) {
    const nextTeam = TEAMS[nextSlot.currentTeam];
    const pings = manager.getTeamPings(nextSlot.currentTeam);
    const gmLabel = manager.getTeamGMLabel(nextSlot.currentTeam);
    await interaction.followUp({
      content: pings,
      embeds: [
        new EmbedBuilder()
          .setColor(nextTeam?.color ?? 0xFFB612)
          .setTitle(`🏈 ${nextTeam?.name ?? nextSlot.currentTeam} are on the clock!`)
          .setDescription(`${gmLabel} — Round ${nextSlot.round}, Pick ${nextSlot.roundPick} · Overall #${nextSlot.overall}`)
      ]
    });
  }
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
  manager: DraftManager
): Promise<void> {
  const query = interaction.options.getFocused();
  const posVal = interaction.options.getString('position');
  const pos = (!posVal || posVal === 'ALL') ? undefined : posVal;
  const results = manager.searchProspects(query, pos);

  const choices = results.map(p => ({
    name: `${p.name} (${p.pos} - ${p.school}) #${p.rank}`,
    value: String(p.rank),
  }));

  await interaction.respond(choices);
}
