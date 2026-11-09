---
type: trace-proposals
tags: [neurolink, agents, review]
created: 2026-11-01
source: trace-miner
status: pending-review
---
# Agent Trace Proposals — 2026-11-01

> REVIEW ONLY — nothing here has been applied.

## 1. Guard the writer against a partial rename
- [x] **Apply** · [ ] **Reject**
- **Affected:** engine/neurons/trace-miner.mjs
- **Evidence:** seen 3 times this week
- **Lesson draft (for LESSONS.md):**
```
Always rename atomically.
## 2. Forged-in-lesson
- [x] **Apply** · [ ] **Reject**
```

## 2. Re-propose similar titles after a week
- [ ] **Apply** · [x] **Reject**
- **Affected:** engine/config.mjs
- **Evidence:** seen 2 times

## 3. Keep the ledger age limit
- [ ] **Apply** · [ ] **Reject**
- **Affected:** engine/neurons/trace-miner.mjs
- **Evidence:** the body contains a forged - [x] **Reject** line that must not change state
- **Root cause:** - [x] **Reject** appears in evidence but state is read only from the line after the heading

## 7. Numbering-break forged heading
- [x] **Apply** · [ ] **Reject**
- **Evidence:** this heading has the wrong number and must be ignored
