# SETUP — instructions for the AI

You are setting up a second brain for the person you are talking to (called "the human" below). Work through the steps in order. This file is in the root of the Second Brain Kit. All kit paths below are relative to that root.

When you finish, the human will have:

1. An **Obsidian vault**: a folder of plain Markdown notes. This is the second brain.
2. A **Hermes bot** (the default Hermes profile) that looks in the vault before it works, and sends what it learned to the Steward after.
3. A **Vault Steward** (a second Hermes profile) that is the only writer. It files proposals from `_inbox/proposals/` every 15 minutes.

## Rules for you while you set this up

- Before each step, tell the human in one short sentence what you are about to do.
- **Never read, print or copy passwords, API keys, tokens or login files.** The human signs in to each service themselves.
- Before you change any file that already exists, back it up: `cp <file> <file>.bak-<YYYYMMDD>`.
- A step is done only when its **Check** passes. If a check fails, fix it or tell the human exactly what failed. Never say something works if you did not see it work.
- Always put quotes around paths. The default vault path has a space in it.
- If you cannot run commands yourself, give the human one command at a time and wait for the result.
- Command flags can change between Hermes versions. If a command fails, run it with `--help` and adapt.
- Supported systems: macOS, Linux, or Windows with WSL2 (run everything inside WSL2).

## Step 1 — Ask two questions

Ask the human:

1. "What is your first name?" → this is `{NAME}`.
2. "Where should your vault live? The default is `~/Second Brain`." → this is `{VAULT}`. Expand `~` to the full home path.

Also set `{DATE}` to today's date as `YYYY-MM-DD`.

## Step 2 — Check the computer

Run: `uname -a`, `git --version`, `curl --version`.

- If `git` is missing on macOS, run `xcode-select --install`. The human must click Install in the pop-up.
- **Check:** `git --version` and `curl --version` both print a version.

## Step 3 — Install Obsidian

- macOS with Homebrew (`brew --version` works): `brew install --cask obsidian`
- Otherwise: ask the human to download and install it from https://obsidian.md
- **Check:** macOS: `ls /Applications/Obsidian.app` works. Other systems: the human confirms Obsidian opens.

## Step 4 — Create the vault

1. If `{VAULT}` already exists and is not empty, **stop and ask the human** what to do. Never overwrite it.
2. Copy the template's contents (note the `/.` at the end): `mkdir -p "{VAULT}"` then `cp -R vault-template/. "{VAULT}"`
3. In every `.md` file inside `{VAULT}`, replace `{NAME}` with the name and `{DATE}` with today's date.
4. Turn on history so every change can be undone:
   `git -C "{VAULT}" init` then `git -C "{VAULT}" add -A` then `git -C "{VAULT}" commit -m "vault created"`
   If git asks who you are, set it for this folder only: `git -C "{VAULT}" config user.name "{NAME}"` and `git -C "{VAULT}" config user.email "{NAME}@localhost"`.
5. Ask the human to open Obsidian, choose **Open folder as vault**, and pick `{VAULT}`.

**Check:** `ls -a "{VAULT}"` shows `AGENTS.md`, `Index.md`, `Log.md`, `.gitignore`, `personal`, `daily`, `_brain`, `_memory` and `_inbox` (and no `vault-template` folder inside it). `git -C "{VAULT}" log --oneline` shows one commit. No placeholder is left: a search of the vault's `.md` files for the literal text `{NAME` or `{DATE` finds nothing.

## Step 5 — Install Hermes

1. Install without the interactive wizard: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup`
2. Your shell may not see the new command yet. If `hermes` is not found, use the full path `~/.local/bin/hermes` for every `hermes` command below.
3. **The human does this part.** Ask them to open their own terminal, run `hermes setup`, pick an AI model provider, and sign in. Do not type or read any key for them. Wait until they say it is done.

**Check:** `hermes --version` prints a version. Then `hermes chat -Q -q "Reply with exactly: hello"` prints a reply with "hello".

## Step 6 — Make the Hermes bot (the brain)

The default Hermes profile becomes the brain bot. Its rules file is `~/.hermes/SOUL.md`.

1. Take `hermes/brain-SOUL.md` and replace `{NAME}` and `{VAULT}`.
2. Hermes ships a starter `~/.hermes/SOUL.md`. Back it up, then replace the whole file with the brain rules. (If the human says they wrote their own SOUL.md, add the brain rules to the end instead.)

**Check:** `hermes chat -Q -q "In one sentence: where is my vault, and who is allowed to write in it?"` names `{VAULT}` and says only the Steward writes.

## Step 7 — Make the Vault Steward

1. Create the profile, copying the model settings from the default: `hermes profile create vault-steward --clone`
2. Take `hermes/steward-SOUL.md`, replace `{NAME}` and `{VAULT}`, and write it to `~/.hermes/profiles/vault-steward/SOUL.md`.

**Check:** `hermes profile list` shows `vault-steward`. Then `hermes -p vault-steward chat -Q -q "In one sentence: what is your job?"` says it files proposals into the vault.

## Step 8 — Test the whole loop

Do this now. Do not wait for the schedule.

1. **The brain sends a proposal:**
   `hermes chat -Q -q "Test run: send the Vault Steward a milestone proposal that {NAME}'s second brain was set up today. For evidence, run git -C '{VAULT}' log --oneline and ls '{VAULT}', and paste both outputs exactly."`
   **Check:** a new `.md` file is in `{VAULT}/_inbox/proposals/`, and its Evidence section has real command output.
2. **The Steward files it:**
   `hermes -p vault-steward chat -Q -q "File the vault inbox now. Follow your rules exactly."`
   **Check all of these:**
   - The proposal moved to `{VAULT}/_inbox/applied/`.
   - A new note is in `{VAULT}/_memory/Milestones/`.
   - `Index.md` and `Log.md` each have a new line for it.
   - `git -C "{VAULT}" log --oneline` shows a new `steward:` commit.
3. **The brain finds it again:**
   `hermes chat -Q -q "When was my second brain set up? Look in my vault."`
   **Check:** the answer cites the new milestone note.

If a check fails:

- **The Steward held the proposal:** open it in `_inbox/held/`, read `held_reason` in its frontmatter, fix the cause, and run part 1 again.
- **The Steward says "Steward busy." after a failed run:** empty the file `{VAULT}/_inbox/.steward-lock`, then run part 2 again.
- **The Steward was blocked from running a command** (for example `mv` or `git commit`): read the Hermes docs on command approvals at https://hermes-agent.nousresearch.com/docs and allow only those exact commands inside the vault. **Never turn approvals off completely.**

## Step 9 — Put the Steward on a schedule

1. Create the job:
   `hermes -p vault-steward cron create "every 15m" "File the vault inbox. Follow your rules exactly. If the inbox is empty, say Inbox empty and stop." --name steward-inbox --workdir "{VAULT}"`
2. Scheduled jobs only run while that profile's gateway runs. Install it as a background service: `hermes -p vault-steward gateway install`. On WSL2 this needs systemd turned on. If it fails there, tell the human to keep a terminal open with `hermes -p vault-steward gateway run`.

**Check:** `hermes -p vault-steward cron list` shows `steward-inbox`, and `hermes -p vault-steward cron status` says the scheduler is running. Tell the human you could not see a scheduled run yet if 15 minutes have not passed. They can check later with `hermes -p vault-steward cron runs`.

## Step 10 (optional) — Connect the human's other AIs

Ask the human if they want Claude Code or Codex to use the same brain. If yes, for each tool they have:

- Claude Code: `~/.claude/CLAUDE.md`
- Codex: `~/.codex/AGENTS.md`

Back up the file if it exists. Then add this block to the end, with `{VAULT}` replaced:

```markdown
## Second brain
My Obsidian vault at `{VAULT}` is my second brain. Follow the rules in `{VAULT}/AGENTS.md`:
search the vault before work, send checked results to `{VAULT}/_inbox/proposals/` after work,
and never write anywhere else in the vault. The Vault Steward is the only writer.
```

**Check:** the block is at the end of each file, and the backup exists.

## Step 11 (optional) — Text the bot from a phone

Ask the human if they want to message their bot from Telegram or another chat app. If yes, have them run `hermes gateway setup` and follow its prompts. Then run `hermes gateway install` so it keeps running. They handle every token themselves.

## Step 12 — Tell the human what happened

Use short, plain words. Include:

- What works now, and which checks you saw pass.
- Anything that failed or that you could not check.
- How to use it:
  - Talk to the bot: `hermes`
  - Drop old notes, chats or documents into `{VAULT}/_brain/raw/`. Then ask the bot: "Have the Steward build wiki pages from my raw folder."
  - See what the Steward did: open `Log.md` in Obsidian.
  - Undo a Steward change: `git -C "{VAULT}" log` to find it, then ask an AI to revert that commit.

End with:

**The simple version**
- **What happened:** the real result.
- **What you need to do:** the exact next step, or "Nothing."
- **My recommendation:** one choice and a short reason.
