# Decisions

Numbered from **#71**. Entries #1–#70 are closed in `docs/DECISIONS-ARCHIVE.md`; the
numbering runs across both files so a citation like `DECISIONS #61` is never ambiguous.

**Write an entry when a choice constrains future code and the reason is not obvious from
reading that code.** A tuning value, a workaround for a library bug, a rule that looks
arbitrary until you know what it prevents. Cite it from the code it constrains
(`// DECISIONS #71`) — the citation is what makes the entry findable later.

**Do not write an entry for what happened.** No round reports, no measurement tables, no
before/after screenshots, no "the critic said X". That material is 55–60% of the archive
and is why the archive became unreadable. It belongs in the commit message, which is where
this repo has always put it well.

Format — the decision, then why, then what it costs:

```
### 71 — 2026-09-09 — The cold-start budget is measured against the build, not the dev server

§7 has budgeted "time to `__READY__` ≤ 6 s cold" since the harness was written, and nothing
ever asserted it. Turning the assertion on against the dev server produced this:

| | warm dev server | cold dev server | production build |
| --- | --- | --- | --- |
| `/` and `?scene=` | 3.6–5.0 s | 7.5–10.9 s | measured by the gate |
| `?showcase=` | 4.5–6.0 s | 9.4–15.0 s | not measured |

The page's own boot did not change between those columns. What changed is that Vite's dev
server hands the browser several hundred separate ES modules and compiles them on demand, so
the first request to a route pays for the whole graph and a warm one does not. A budget
asserted there fails or passes on how recently someone else loaded the same URL.

**`readyMs` is therefore recorded on every shot and asserted on none of them.** The budget is
checked once per gate run, by `tools/gate.js → coldBoot()`, against the production bundle
served by `vite preview` — the bytes a player actually downloads.

**Why:** the alternatives were worse. Warming the server first would have measured nothing.
Raising the number until the dev server passed would have set the player's budget at 15 s to
accommodate a bundler the player never runs. Splitting it by URL — which is what this entry
said in its first draft, before the cold run — treated the symptom: showcases looked slower
only because they are shot after the scenes, on a server the scenes had already warmed.

**Cost:** one boot path is measured instead of twenty-two, so a route that is slow for its own
reasons — a showcase that stages an enormous scenario — will not be caught by this budget. The
draw-call and text floors in `tools/shots/boot.js` still cover every route; only the timing
does not.
