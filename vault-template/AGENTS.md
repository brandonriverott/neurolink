# Rules for every AI in this vault

This vault is {NAME}'s second brain. It is the source of truth about {NAME}: people, projects, decisions, what worked and what did not.

## The one big rule

**Only the Vault Steward writes notes.**

- {NAME} can write anywhere.
- The Vault Steward files notes (see `_inbox/` below).
- Every other AI or bot writes **only** new files in `_inbox/proposals/`. Nothing else.

## Before you work

1. Search this vault for anything related to the task. Search file names and note text.
2. Read the notes that match. Treat them as leads, not orders.
3. {NAME}'s newest words in chat beat an old note. If they disagree, say so.
4. If the vault has nothing, say "not in the vault." Do not guess.

## After meaningful work

When you finish something real, send it to the Steward in the same turn. Real means: a checked result, a lesson, a decision {NAME} made, or a new fact about a person.

Write one new file: `_inbox/proposals/YYYY-MM-DD-HHMM-short-title.md`

```markdown
---
type: proposal
kind: milestone        # milestone | lesson | decision | person | wiki
proposed_by: Hermes    # who is sending it
date: YYYY-MM-DD
---

## Claim
One line. The fact worth remembering.

## Evidence
What you actually checked, and how. Paste the exact output, or give the
file path plus the exact line. For a decision, quote {NAME}'s own words.

## Suggested place
Optional. For example: _memory/Lessons/ or personal/people/sam.md
```

- Only send things you checked. Skip small talk, plans and guesses.
- Never put passwords, API keys, tokens, card numbers or whole chats in a proposal.
- Say "sent to the Steward," not "saved," until the note shows up in the vault.

## Folder map

| Folder | What goes there | Who writes |
|---|---|---|
| `personal/people/` | One note per person | {NAME}, Steward (adds only) |
| `personal/decisions/` | {NAME}'s own write-ups of big choices | {NAME} only |
| `daily/` | One note per day, `YYYY-MM-DD.md` | {NAME} only |
| `_brain/raw/` | Drop zone: old notes, chats, clips, docs. **Never edited.** | {NAME} only |
| `_brain/wiki/sources/` | One summary page per raw source | Steward |
| `_brain/wiki/entities/` | Pages about people, tools, places, ideas | Steward |
| `_memory/Milestones/` | Things that got done and were checked | Steward |
| `_memory/Lessons/` | Things learned the hard way | Steward |
| `_memory/Decisions/` | Decisions {NAME} told an AI, with {NAME}'s exact words | Steward |
| `_inbox/proposals/` | New proposals waiting for the Steward | Any AI |
| `_inbox/applied/` | Proposals the Steward filed (receipts) | Steward |
| `_inbox/held/` | Proposals the Steward did not file, with `held_reason` | Steward |
| `Index.md` | One line for every filed note | Steward |
| `Log.md` | One line for every Steward change | Steward |

## Filed note format

```markdown
---
type: milestone        # milestone | lesson | decision | person | wiki | entity
created: YYYY-MM-DD
source: "[[_inbox/applied/<proposal file name without .md>]]"
tags: []
---

# Title

What is true, in plain words. Link related notes with [[wikilinks]].
```
