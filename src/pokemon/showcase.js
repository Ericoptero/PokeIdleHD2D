/** pokemon showcase: every direction and walk frame of the trainer and a few species. */
export async function showcasePokemon(mode, ctx) {
  await ctx.get('city')?.enter?.();
  ctx.log.info('pokemon showcase: sprite staging is owned by the pokemon builder');
}
