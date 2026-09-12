# Working in PokeIdleHD2D

Use **understand → implement → validate → deliver**. This file is the single source
of work rules for all coding agents in this repository.

- Prioritize the current request → code → tests → configuration → necessary documentation.
- Start with targeted `rg` searches. Read relevant files and expand only through actual
  dependencies; avoid scanning unrelated subsystems or loading documentation wholesale.
- Implement small tasks directly. For complex tasks, a short plan in the conversation is enough.
- Keep changes focused and follow existing patterns. Preserve unrelated work.
- Validate in proportion to the change, using checks that exercise the requested behavior.
  Fix problems introduced by the change; describe relevant pre-existing failures locally.
- Delivery depends on the requested behavior and relevant checks. Additional documents,
  delegation, repeated reviews and confirmation are not mandatory steps.
- Report what changed, what was checked and any remaining material limitations.

The game uses plain JavaScript ES modules, three.js and Vite, with opt-in JSDoc type checking.
[ARCHITECTURE.md](ARCHITECTURE.md) maps subsystems, technical contracts and investigation paths.
Treat the code as authoritative when the map differs from it.

Available checks are optional tools selected to fit the task:

- `npm run lint`, `npm run typecheck`, `npm run seams`, `npm run unit`, `npm run build`.
- `npx vitest run <file>` for a focused unit test; `npm run flows -- <file>` for browser flows.
- `npm run gate` runs the combined checks; `npm run gate:fast` runs the browser-free subset.
  `node tools/gate.js --list` lists stages; `--only a,b` and `--skip a,b` select them.
- `npm run shot -- --out shots/out/example.png --tod 11` captures one frame.
  `npm run gauntlet -- --module city` runs an optional capture matrix;
  `--out shots/out/custom` selects its output directory.
- Capture and browser checks use Chrome (`CHROME_PATH`); gate servers use `GATE_PORT`.
  Outputs under `shots/out/` are ignored. Visual references and the regression baseline
  live in `docs/refs/` and `docs/baseline.json`.
