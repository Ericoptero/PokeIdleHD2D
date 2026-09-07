/**
 * A small, real subset so the game runs before the full snapshot exists. The `pokemon`
 * builder replaces this with public/generated/species.json (all nine generations).
 */
export const STARTERS = [
  { id: 1, name: 'bulbasaur', types: ['grass', 'poison'], gen: 1, baseStats: { hp: 45, atk: 49, def: 49, spa: 65, spd: 65, spe: 45 } },
  { id: 4, name: 'charmander', types: ['fire'], gen: 1, baseStats: { hp: 39, atk: 52, def: 43, spa: 60, spd: 50, spe: 65 } },
  { id: 7, name: 'squirtle', types: ['water'], gen: 1, baseStats: { hp: 44, atk: 48, def: 65, spa: 50, spd: 64, spe: 43 } },
  { id: 25, name: 'pikachu', types: ['electric'], gen: 1, baseStats: { hp: 35, atk: 55, def: 40, spa: 50, spd: 50, spe: 90 } },
  { id: 133, name: 'eevee', types: ['normal'], gen: 1, baseStats: { hp: 55, atk: 55, def: 50, spa: 45, spd: 65, spe: 55 } },
  { id: 261, name: 'poochyena', types: ['dark'], gen: 3, baseStats: { hp: 35, atk: 55, def: 35, spa: 30, spd: 30, spe: 35 } },
  { id: 396, name: 'starly', types: ['normal', 'flying'], gen: 4, baseStats: { hp: 40, atk: 55, def: 30, spa: 30, spd: 30, spe: 60 } },
  { id: 504, name: 'patrat', types: ['normal'], gen: 5, baseStats: { hp: 45, atk: 55, def: 39, spa: 35, spd: 39, spe: 42 } },
  { id: 906, name: 'sprigatito', types: ['grass'], gen: 9, baseStats: { hp: 40, atk: 61, def: 54, spa: 45, spd: 45, spe: 65 } },
  { id: 909, name: 'fuecoco', types: ['fire'], gen: 9, baseStats: { hp: 67, atk: 45, def: 59, spa: 63, spd: 40, spe: 36 } },
  { id: 912, name: 'quaxly', types: ['water'], gen: 9, baseStats: { hp: 55, atk: 65, def: 45, spa: 50, spd: 45, spe: 50 } },
];
