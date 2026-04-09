# MockDraftBot

A Discord bot for running full 7-round NFL mock drafts with your server. Supports pick trading, player trades with salary cap enforcement, custom draft boards, auto-pick timers, and more.

## Features

- **Full Mock Draft** — 7-round draft with 500+ ranked prospects, position filtering, and autocomplete search
- **Trading** — Trade current-year picks, future picks (2027-2028), and rostered players
- **Salary Cap** — Optional enforcement using real NFL salary data from Spotrac, including dead money, rookie slot projections, and effective cap space
- **Custom Boards** — GMs can submit custom player rankings or position priority lists for auto-pick
- **Timers** — Configurable per-pick timer with auto-pick on expiry
- **Co-Managers** — Multiple users can manage the same team
- **Trade Announcements** — Private, public, or "intrigue" mode (delayed reveal)
- **Persistence** — Draft state saves to disk and survives bot restarts

## Commands

| Command | Description |
|---------|-------------|
| `/draft` | Admin setup — register teams, configure timer, start/pause/resume |
| `/pick` | Make your pick when on the clock |
| `/autopick` | Let the CPU pick best available for your team |
| `/board` | View available prospects, submit custom board, set position priority |
| `/trade` | Propose, accept, or decline trades (picks, players, future picks) |
| `/inventory` | View a GM's picks, roster, and cap info |
| `/status` | Current draft status, on the clock, recent picks |
| `/upcoming` | Preview next upcoming picks |
| `/roster` | View a team's draft selections |
| `/recap` | Link to live draft recap |
| `/help` | Full usage guide |

## Setup

### Prerequisites

- Node.js 18+
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))

### Installation

```bash
git clone https://github.com/myellen/MockDraftBot.git
cd MockDraftBot
npm install
```

### Configuration

Copy `.env.example` to `.env` and fill in:

```
DISCORD_TOKEN=your_bot_token
CLIENT_ID=your_application_client_id
GUILD_ID=your_server_guild_id
SUPER_ADMINS=comma_separated_admin_user_ids
```

### Generate Data

The bot needs roster and salary data generated from external sources:

```bash
npx ts-node scripts/generate-rosters.ts    # Fetches current NFL rosters from ESPN
npx ts-node scripts/generate-salaries.ts   # Fetches salary data from Spotrac/OTC
```

### Invite the Bot

Use this URL format to invite the bot to your server (replace `[CLIENT_ID]` with your application's client ID):

```
https://discord.com/oauth2/authorize?client_id=[CLIENT_ID]&permissions=379904&scope=bot%20applications.commands
```

This grants the bot: View Channels, Send Messages, Embed Links, Attach Files, Read Message History, and Use External Emojis.

### Deploy Commands & Run

```bash
npx ts-node src/deploy-commands.ts   # Register slash commands with Discord
npx ts-node src/index.ts             # Start the bot
```

## Project Structure

```
src/
  commands/       # Slash command handlers
  data/           # Generated data (rosters, salaries, prospects, teams, draft order)
  draft/          # Core logic (DraftManager, TradeManager, types, embeds)
scripts/          # Data generation scripts
data/             # Persistent draft state (per-guild JSON files)
tests/            # Trade cap validation tests
docs/             # CBA reference documentation
```

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Discord:** discord.js v14
- **Data:** Spotrac (salaries), ESPN (rosters), custom prospect rankings
- **Persistence:** JSON files on disk

## Acknowledgments

Special thanks to The Athletic Football Show Discord server for hosting the bot. And thank you to its members for their ethusiasm for drafting, their helpful feedback, their patience during the occasional bot takeover, and above all else, their immense Ball Knowledge.
