# TLCG Workflow: notes for AI sessions

Several tools work on this repo: Cursor (Claude Code), Claude Desktop (local) and Claude Code cloud sessions.

1. Before starting, read `docs/SESSION_LOG.md` (who did what, what is left, where things run) and `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md` (the plan of record).
2. Before ending, add an entry at the top of `docs/SESSION_LOG.md`: what you did, commits, what you found, what is left.
3. Never deploy to or change **workflow.tl-c.us** (the live GAS site). The new Postgres system runs on **wf.tl-c.us** (Mac Mini).
4. A cloud session sees only GitHub, not the MacBook folder or the Mac Mini. Push from the folder before handing work to a cloud session, and `git pull` after it.
