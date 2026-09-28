# Neurolink

Give your AI a memory that lasts.

Download this kit, give it to your AI, and it sets up three things on your computer:

1. **An Obsidian vault.** A folder of plain notes. This is your second brain. You own it.
2. **A Hermes bot.** Your AI helper. Before it works, it looks in your vault. After it works, it sends what it learned to the Steward.
3. **A Vault Steward.** A second Hermes bot. It is the only one allowed to write notes. It checks each thing sent to it and files it in the right place.

## How it works

```
You ask ──▶ Hermes bot ──▶ looks in your vault ──▶ does the work
                                                        │
                                                        ▼
                                   drops a proposal in _inbox/proposals/
                                                        │
                                   every 15 minutes     ▼
                            Vault Steward ──▶ checks it ──▶ files the note
                                                       └──▶ updates Index.md + Log.md
```

Your brain grows every time you use it. Nothing gets filed without a check.

## Set it up (about 30 minutes)

**You need:**

- A Mac, Linux, or Windows with WSL2.
- An AI that can run commands on your computer, like [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex).
- An account with an AI model provider for Hermes (for example ChatGPT, Claude, OpenRouter or Nous Portal).

**Steps:**

1. Download this kit. Click **Code → Download ZIP** and unzip it, or run:
   ```bash
   git clone https://github.com/brandonriverott/neurolink.git
   ```
2. Open your AI inside the kit folder.
3. Tell it: **"Read SETUP.md and set up my second brain."**

The AI does the rest. It stops and asks you when it needs you.

**You will do these parts yourself:**

- Sign in to your AI model account. The AI never sees your password or keys.
- Open the vault in Obsidian once.
- Click OK on any computer security pop-ups.

## What is inside

| Path | What it is |
|---|---|
| `SETUP.md` | Step-by-step instructions for your AI |
| `vault-template/` | The empty vault: folders, rules (`AGENTS.md`), `Index.md`, `Log.md` |
| `hermes/brain-SOUL.md` | Rules for your Hermes bot |
| `hermes/steward-SOUL.md` | Rules for the Vault Steward |

## Your vault's folders

| Folder | What goes there |
|---|---|
| `personal/` | Your life: `people/` and your own write-ups in `decisions/` |
| `daily/` | One note per day (yours; bots never edit it) |
| `_brain/raw/` | Drop old notes, chats and documents here. Then ask your bot to have the Steward turn them into wiki pages. |
| `_brain/wiki/` | Wiki pages the Steward builds from your raw files |
| `_memory/` | What got done, what was learned, and decisions you told an AI |
| `_inbox/` | Proposals waiting for the Steward, and receipts for filed ones |

## Good to know

- **Your notes stay on your computer.** The kit sends nothing anywhere. The only exception: when a bot reads notes to do a task, those notes go to the AI model you picked.
- **"Only the Steward writes" is a rule, not a lock.** The bots follow it because their instructions say so. It is not a security wall.
- **You can undo anything.** The vault uses git on your computer, so every Steward change is saved and can be reversed. Do not push your vault to a public GitHub repo; it is private.
- **No database, no search server.** The bots search your notes directly. The only thing running in the background is the Hermes service that wakes the Steward every 15 minutes.

## License

MIT. See `LICENSE`.
