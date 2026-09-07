/** idle showcase: the accrual curve and the background-tab reconciliation, on screen. */
export async function showcaseIdle(mode, ctx) {
  await ctx.get('city')?.enter?.();
  const idle = ctx.get('idle');
  ctx.get('ui').toast?.(`idle rate: ${JSON.stringify(idle.rate?.())}`);
}
