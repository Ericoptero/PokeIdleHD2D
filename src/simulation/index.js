/**
 * simulation — the world tick: player, grid movement, follower conga line, NPCs
 * (ARCHITECTURE §5.4). SEED IMPLEMENTATION; the `simulation` builder owns this folder.
 */

import { DIR_DX, DIR_DZ, SOUTH } from '../core/dir.js';

export default {
  id: 'simulation',
  needs: ['terrain', 'pokemon'],
  /** Extra modules the showcase scene needs on top of `needs` (ARCHITECTURE §6). */
  showcaseNeeds: ['city', 'terrain'],

  init(ctx) {
    const { config, bus } = ctx;
    const player = { cx: 0, cz: 0, dir: SOUTH, moving: false, running: false, t: 0, fromX: 0, fromZ: 0 };
    const npcs = [];
    /** Cells the player has occupied, newest first; the follower walks this trail. */
    const trail = [];
    let intent = null;

    function placePlayer(cx, cz, dir = SOUTH) {
      player.cx = cx; player.cz = cz; player.dir = dir;
      player.moving = false; player.t = 0;
      trail.length = 0;
      for (let i = 0; i < 8; i++) trail.push({ cx, cz, dir });
      bus.emit('player:moved', { cx, cz, dir, running: false });
    }

    function beginStep(dir, running) {
      const terrain = ctx.get('terrain');
      const nx = player.cx + DIR_DX[dir], nz = player.cz + DIR_DZ[dir];
      player.dir = dir;
      if (!terrain.passable(nx, nz, dir)) return false;
      player.fromX = player.cx; player.fromZ = player.cz;
      player.cx = nx; player.cz = nz;
      player.moving = true; player.running = running; player.t = 0;
      trail.unshift({ cx: nx, cz: nz, dir });
      if (trail.length > 32) trail.length = 32;
      bus.emit('player:moved', { cx: nx, cz: nz, dir, running });
      bus.emit('player:enteredTile', { cx: nx, cz: nz, tags: terrain.tagsAt(nx, nz) });
      return true;
    }

    return {
      player: () => ({ ...player }),
      /** Smoothed world position for rendering, interpolated across the step. */
      playerWorld() {
        const terrain = ctx.get('terrain');
        const k = player.moving ? player.t : 1;
        const x = player.fromX + (player.cx - player.fromX) * k;
        const z = player.fromZ + (player.cz - player.fromZ) * k;
        return { x: x + 0.5, y: terrain.height(player.cx, player.cz), z: z + 0.5 };
      },
      placePlayer,
      moveIntent(dir, running = false) { intent = { dir, running }; },
      stop() { intent = null; },
      trail: () => trail.slice(),
      /** The lead Pokemon walks `followerGapTiles` behind the player along the trail. */
      followerCell() {
        const gap = Math.max(1, config.followerGapTiles);
        return trail[Math.min(gap, trail.length - 1)] ?? { cx: player.cx, cz: player.cz, dir: player.dir };
      },
      spawnNpc(spec) { npcs.push({ ...spec }); return npcs[npcs.length - 1]; },
      npcs: () => npcs.slice(),
      teleport: placePlayer,
      _advance(dt) {
        if (player.moving) {
          const per = player.running ? config.runSecondsPerTile : config.walkSecondsPerTile;
          player.t += dt / Math.max(0.01, per);
          if (player.t >= 1) { player.t = 1; player.moving = false; }
        }
        if (!player.moving && intent) beginStep(intent.dir, intent.running);
      },
    };
  },

  tick(dt, ctx) {
    ctx.get('simulation')._advance(dt);
    const sim = ctx.get('simulation');
    const p = sim.playerWorld?.();
    if (p) ctx.three.rig.setFocus(p.x, p.y, p.z);
  },

  async showcase(mode, ctx) {
    await ctx.get('city').enter?.();
  },
};
