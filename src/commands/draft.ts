import {
  SlashCommandBuilder, ChatInputCommandInteraction,
  AutocompleteInteraction, ChannelType, EmbedBuilder
} from 'discord.js';
import { DraftManager } from '../draft/DraftManager';
import { TEAMS } from '../data/teams';
import { isAdmin } from '../utils/permissions';
import { buildAssignmentsEmbed } from '../utils/embeds';
import { ordinal } from '../utils/ordinal';
import { TradeAnnouncement } from '../draft/types';

export const data = new SlashCommandBuilder()
  .setName('draft')
  .setDescription('2026 NFL Mock Draft management')
  .addSubcommand(sub => sub
    .setName('setup')
    .setDescription('Configure the draft (admin only)')
    .addChannelOption(opt => opt
      .setName('channel')
      .setDescription('Channel for draft announcements')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true)
    )
    .addIntegerOption(opt => opt
      .setName('timer')
      .setDescription('Minutes per pick (0 = no timer)')
      .setMinValue(0)
      .setMaxValue(1440)
      .setRequired(false)
    )
    .addBooleanOption(opt => opt
      .setName('autopick')
      .setDescription('Auto-pick for unassigned teams (default: true)')
      .setRequired(false)
    )
    .addIntegerOption(opt => opt
      .setName('rounds')
      .setDescription('Number of rounds to simulate (default: 7)')
      .setMinValue(1)
      .setMaxValue(7)
      .setRequired(false)
    )
    .addBooleanOption(opt => opt
      .setName('allow-player-trades')
      .setDescription('Allow players in trades (default: true)')
      .setRequired(false)
    )
    .addStringOption(opt => opt
      .setName('trade-announcement')
      .setDescription('How trade proposals are announced (default: intrigue)')
      .setRequired(false)
      .addChoices(
        { name: 'Private — no public notification', value: 'private' },
        { name: 'Public — full trade details shown publicly', value: 'public' },
        { name: 'Intrigue — public ping without details', value: 'intrigue' },
      )
    )
    .addBooleanOption(opt => opt
      .setName('enforce-salary-cap')
      .setDescription('Validate trades against salary cap (default: false)')
      .setRequired(false)
    )
  )
  .addSubcommand(sub => sub
    .setName('register')
    .setDescription('Claim an NFL team')
    .addStringOption(opt => opt
      .setName('team')
      .setDescription('Team abbreviation (e.g. LV, NYJ, KC)')
      .setRequired(true)
      .setAutocomplete(true)
    )
  )
  .addSubcommand(sub => sub
    .setName('unregister')
    .setDescription('Release your team')
  )
  .addSubcommand(sub => sub
    .setName('assignments')
    .setDescription('Show all team → user assignments')
  )
  .addSubcommand(sub => sub
    .setName('start')
    .setDescription('Begin the draft (admin only)')
  )
  .addSubcommand(sub => sub
    .setName('pause')
    .setDescription('Pause the draft (admin only)')
  )
  .addSubcommand(sub => sub
    .setName('resume')
    .setDescription('Resume the draft (admin only)')
  )
  .addSubcommand(sub => sub
    .setName('reset')
    .setDescription('Clear picks/trades and return to idle — keeps assignments, boards, and config (admin only)')
  )
  .addSubcommand(sub => sub
    .setName('wipe')
    .setDescription('Wipe ALL state including assignments, boards, and config (admin only)')
  )
  .addSubcommand(sub => sub
    .setName('rewind')
    .setDescription('Rewind the draft to a specific pick (admin only)')
    .addIntegerOption(opt => opt
      .setName('round')
      .setDescription('Round number (1–7)')
      .setMinValue(1).setMaxValue(7)
      .setRequired(true)
    )
    .addIntegerOption(opt => opt
      .setName('pick')
      .setDescription('Pick number within the round (1–32)')
      .setMinValue(1).setMaxValue(32)
      .setRequired(true)
    )
  )
  .addSubcommand(sub => sub
    .setName('add-comanager')
    .setDescription('Add a co-manager to your team who can make picks and trades')
    .addUserOption(opt => opt
      .setName('user')
      .setDescription('The user to add as co-manager')
      .setRequired(true)
    )
  )
  .addSubcommand(sub => sub
    .setName('remove-comanager')
    .setDescription('Remove a co-manager from your team')
    .addStringOption(opt => opt
      .setName('user')
      .setDescription('The co-manager to remove')
      .setRequired(true)
      .setAutocomplete(true)
    )
  )
  .addSubcommandGroup(group => group
    .setName('admin')
    .setDescription('Admin override commands')
    .addSubcommand(sub => sub
      .setName('assign')
      .setDescription('Assign any team to any user (admin only)')
      .addStringOption(opt => opt
        .setName('team')
        .setDescription('Team abbreviation')
        .setRequired(true)
        .setAutocomplete(true)
      )
      .addUserOption(opt => opt
        .setName('user')
        .setDescription('The user to assign')
        .setRequired(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('co-manager')
      .setDescription('Add a co-manager to any team (admin only)')
      .addStringOption(opt => opt
        .setName('team')
        .setDescription('Team abbreviation')
        .setRequired(true)
        .setAutocomplete(true)
      )
      .addUserOption(opt => opt
        .setName('user')
        .setDescription('The user to add as co-manager')
        .setRequired(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('undo-trade')
      .setDescription('Reverse a completed trade (admin only)')
      .addStringOption(opt => opt
        .setName('id')
        .setDescription('Trade ID')
        .setRequired(true)
        .setAutocomplete(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('pick')
      .setDescription('Make a pick for the team currently on the clock (admin only)')
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
      )
    )
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  manager: DraftManager
): Promise<void> {
  const sub = interaction.options.getSubcommand();

  // Admin-only commands
  const adminCmds = ['setup', 'start', 'pause', 'resume', 'reset', 'rewind', 'wipe'];
  if (adminCmds.includes(sub) && !isAdmin(interaction)) {
    await interaction.reply({ content: '❌ You need Administrator permission to use this command.', ephemeral: true });
    return;
  }

  if (sub === 'setup') {
    const channel = interaction.options.getChannel('channel', true);
    const timer = interaction.options.getInteger('timer') ?? null;
    const autopick = interaction.options.getBoolean('autopick') ?? true;
    const rounds = interaction.options.getInteger('rounds') ?? 7;
    const allowPlayerTrades = interaction.options.getBoolean('allow-player-trades') ?? true;
    const tradeAnnouncement = (interaction.options.getString('trade-announcement') ?? 'intrigue') as TradeAnnouncement;
    const enforceSalaryCap = interaction.options.getBoolean('enforce-salary-cap') ?? false;

    await manager.setup({
      channelId: channel.id,
      timerSeconds: timer === 0 ? null : (timer !== null ? timer * 60 : null),
      autoPick: autopick,
      rounds,
      allowPlayerTrades,
      tradeAnnouncement,
      enforceSalaryCap,
    });

    const timerStr = timer ? `${timer}m per pick` : 'No timer';
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x57F287)
          .setTitle('✅ Draft Configured')
          .addFields(
            { name: 'Channel',   value: `<#${channel.id}>`, inline: true },
            { name: 'Timer',     value: timerStr,            inline: true },
            { name: 'Auto-Pick', value: autopick ? 'On' : 'Off', inline: true },
            { name: 'Rounds',    value: String(rounds),      inline: true },
            { name: 'Player Trades', value: allowPlayerTrades ? 'On' : 'Off', inline: true },
            { name: 'Trade Announcements', value: tradeAnnouncement.charAt(0).toUpperCase() + tradeAnnouncement.slice(1), inline: true },
            { name: 'Salary Cap', value: enforceSalaryCap ? 'Enforced' : 'Off', inline: true },
          )
          .setDescription('Now have GMs register their teams with `/draft register`, then use `/draft start` when ready.')
      ]
    });

  } else if (sub === 'register') {
    const teamAbbr = interaction.options.getString('team', true).toUpperCase();
    const result = await manager.registerTeam(teamAbbr, interaction.user.id);
    if (!result.success) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }
    const team = TEAMS[teamAbbr];
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(team.color)
          .setTitle('🏈 Team Registered!')
          .setDescription(`<@${interaction.user.id}> is now the GM of the **${team.name}**!`)
      ]
    });

  } else if (sub === 'unregister') {
    const result = await manager.unregisterTeam(interaction.user.id);
    if (!result.success) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: '✅ You have released your team.', ephemeral: true });

  } else if (sub === 'assignments') {
    const state = manager.getState();
    const embed = buildAssignmentsEmbed(state.assignments, TEAMS);
    await interaction.reply({ embeds: [embed] });

  } else if (sub === 'start') {
    await interaction.deferReply();
    const result = await manager.start();
    if (!result.success) {
      await interaction.editReply(`❌ ${result.error}`);
      return;
    }
    await interaction.editReply({ content: '🏈 **The 2026 NFL Mock Draft has begun!**' });

  } else if (sub === 'pause') {
    await manager.pause();
    await interaction.reply({ content: '⏸️ Draft paused.', ephemeral: true });

  } else if (sub === 'resume') {
    await interaction.deferReply({ ephemeral: true });
    await manager.resume();
    await interaction.editReply('▶️ Draft resumed.');

  } else if (sub === 'reset') {
    await manager.reset();
    await interaction.reply({ content: '🔄 Draft reset. Picks, trades, and schedule cleared — assignments and boards preserved.', ephemeral: true });

  } else if (sub === 'wipe') {
    await manager.wipe();
    await interaction.reply({ content: '🗑️ Full wipe complete. All state cleared.', ephemeral: true });

  } else if (sub === 'rewind') {
    const round = interaction.options.getInteger('round', true);
    const pick = interaction.options.getInteger('pick', true);
    await interaction.deferReply({ ephemeral: true });
    const result = await manager.rewind(round, pick);
    if (!result.success) {
      await interaction.editReply(`❌ ${result.error}`);
      return;
    }
    await interaction.editReply(`⏪ Draft rewound to Round ${round}, Pick ${pick}.`);

  } else if (sub === 'add-comanager') {
    const user = interaction.options.getUser('user', true);
    const result = await manager.addCoManager(interaction.user.id, user.id);
    if (!result.success) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }
    const team = manager.getUserTeam(interaction.user.id);
    await interaction.reply({ content: `✅ <@${user.id}> added as co-manager for the **${TEAMS[team!]?.name}**.`, ephemeral: true });

  } else if (sub === 'remove-comanager') {
    const coManagerId = interaction.options.getString('user', true);
    const result = await manager.removeCoManager(interaction.user.id, coManagerId);
    if (!result.success) {
      await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `✅ Co-manager removed.`, ephemeral: true });

  } else if (sub === 'assign' || sub === 'co-manager' || sub === 'undo-trade' || sub === 'pick') {
    // Admin subcommand group
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: '❌ You need Administrator permission to use this command.', ephemeral: true });
      return;
    }

    if (sub === 'assign') {
      const teamAbbr = interaction.options.getString('team', true).toUpperCase();
      const user = interaction.options.getUser('user', true);
      const result = await manager.adminAssignTeam(teamAbbr, user.id);
      if (!result.success) {
        await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        return;
      }
      await interaction.reply({ content: `✅ <@${user.id}> assigned as GM of the **${TEAMS[teamAbbr]?.name ?? teamAbbr}**.`, ephemeral: true });

    } else if (sub === 'co-manager') {
      const teamAbbr = interaction.options.getString('team', true).toUpperCase();
      const user = interaction.options.getUser('user', true);
      const result = await manager.adminAddCoManager(teamAbbr, user.id);
      if (!result.success) {
        await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        return;
      }
      await interaction.reply({ content: `✅ <@${user.id}> added as co-manager for the **${TEAMS[teamAbbr]?.name ?? teamAbbr}**.`, ephemeral: true });

    } else if (sub === 'undo-trade') {
      const tradeId = interaction.options.getString('id', true).toUpperCase();
      const result = await manager.adminUndoTrade(tradeId);
      if (!result.success) {
        await interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
        return;
      }
      await interaction.reply({ content: `✅ Trade **[${tradeId}]** reversed.`, ephemeral: true });

    } else if (sub === 'pick') {
      const rankStr = interaction.options.getString('player', true);
      const rank = parseInt(rankStr, 10);
      if (isNaN(rank)) {
        await interaction.reply({ content: '❌ Invalid player selection. Use the autocomplete to choose a player.', ephemeral: true });
        return;
      }
      await interaction.deferReply();
      const result = await manager.adminMakePick(rank);
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

      const nextSlot = manager.getCurrentSlot();
      if (nextSlot) {
        const nextTeam = TEAMS[nextSlot.currentTeam];
        const state = manager.getState();
        const gmId = state.assignments[nextSlot.currentTeam];
        const ping = gmId ? `<@${gmId}>` : 'No GM assigned';
        await interaction.followUp({
          content: gmId ? `<@${gmId}>` : undefined,
          embeds: [
            new EmbedBuilder()
              .setColor(nextTeam?.color ?? 0xFFB612)
              .setTitle(`🏈 ${nextTeam?.name ?? nextSlot.currentTeam} are on the clock!`)
              .setDescription(`${ping} — Round ${nextSlot.round}, Pick ${nextSlot.roundPick} · Overall #${nextSlot.overall}`)
          ]
        });
      }
    }
  }
}

export async function autocomplete(
  interaction: AutocompleteInteraction,
  manager: DraftManager
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const focused = interaction.options.getFocused(true);
  const q = (focused.value as string).toUpperCase();

  if (sub === 'register') {
    const unassigned = manager.getUnassignedTeams();
    const choices = unassigned
      .filter(abbr => abbr.includes(q) || TEAMS[abbr].name.toUpperCase().includes(q))
      .slice(0, 25)
      .map(abbr => ({ name: `${TEAMS[abbr].name} (${abbr})`, value: abbr }));
    await interaction.respond(choices);
    return;
  }

  if (sub === 'remove-comanager') {
    const team = manager.getUserTeam(interaction.user.id);
    if (!team) { await interaction.respond([]); return; }
    const coManagers = manager.getCoManagers(team);
    const choices = coManagers
      .filter(id => id.includes(q))
      .slice(0, 25)
      .map(id => ({ name: `<@${id}> (${id})`, value: id }));
    await interaction.respond(choices);
    return;
  }

  // Admin subcommand autocomplete
  if (sub === 'assign' || sub === 'co-manager') {
    const state = manager.getState();
    const choices = Object.keys(TEAMS)
      .filter(abbr => abbr.includes(q) || TEAMS[abbr].name.toUpperCase().includes(q))
      .slice(0, 25)
      .map(abbr => {
        const gmId = state.assignments[abbr];
        const gmLabel = gmId ? ` (GM assigned)` : ' (no GM)';
        return { name: `${TEAMS[abbr].name} (${abbr})${gmLabel}`, value: abbr };
      });
    await interaction.respond(choices);
    return;
  }

  if (sub === 'undo-trade') {
    const history = manager.getTradeHistory();
    const choices = history
      .filter(t => t.id.includes(q))
      .slice(0, 25)
      .map(t => {
        const summary = [
          t.offeredOveralls.map(o => `#${o}`).join(', '),
          t.offeredPlayers.join(', '),
        ].filter(Boolean).join(' + ') || '…';
        return {
          name: `[${t.id}] ${TEAMS[t.proposerTeam]?.name ?? t.proposerTeam} → ${TEAMS[t.receiverTeam]?.name ?? t.receiverTeam}: ${summary}`.slice(0, 100),
          value: t.id,
        };
      });
    await interaction.respond(choices);
    return;
  }

  if (sub === 'pick' && focused.name === 'player') {
    const posVal = interaction.options.getString('position');
    const pos = (!posVal || posVal === 'ALL') ? undefined : posVal;
    const results = manager.searchProspects(focused.value as string, pos);
    const choices = results.map(p => ({
      name: `${p.name} (${p.pos} - ${p.school}) #${p.rank}`,
      value: String(p.rank),
    }));
    await interaction.respond(choices);
    return;
  }

  await interaction.respond([]);
}
