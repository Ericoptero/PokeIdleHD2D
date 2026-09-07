/** collection — dex, boxes, organisation (ARCHITECTURE §5.10). SEED. */
export default {
  id: 'collection',
  needs: ['pokemon'],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['city', 'terrain'],
  init(ctx) {
    const seen = new Set();
    const caught = new Set();
    const boxes = [[]];
    ctx.bus.on('catch:succeeded', ({ species, instanceId }) => {
      const isNew = !caught.has(species);
      caught.add(species); seen.add(species);
      boxes[0].push({ instanceId, species });
      ctx.bus.emit('collection:added', { instanceId, isNewSpecies: isNew });
    });
    ctx.bus.on('encounter:started', ({ species }) => seen.add(species));
    return {
      dex: () => ({ seen: [...seen], caught: [...caught], total: ctx.get('pokemon').count?.() ?? 0 }),
      boxes: () => boxes.map((b) => b.slice()),
      move(inst, box, slot) { const from = boxes.findIndex((b) => b.includes(inst)); if (from < 0) return false; boxes[from].splice(boxes[from].indexOf(inst), 1); (boxes[box] ??= []).splice(slot, 0, inst); return true; },
      sort(mode = 'species') { for (const b of boxes) b.sort((a, c) => (mode === 'species' ? a.species.localeCompare(c.species) : 0)); },
      release(inst) { for (const b of boxes) { const i = b.indexOf(inst); if (i >= 0) { b.splice(i, 1); return true; } } return false; },
      stats: () => ({ caught: caught.size, seen: seen.size, stored: boxes.reduce((a, b) => a + b.length, 0) }),
    };
  },
  async showcase(mode, ctx) { await ctx.get('city').enter?.(); },
};
