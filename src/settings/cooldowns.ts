// The auto-chime cooldowns a group can choose, in minutes: after the bot speaks, it doesn't join
// in on its own for this long (0: only the 30 s quiet debounce). Kept free of zod so the Mini App
// can import it without bundling zod.
export const CHIME_COOLDOWNS = [0, 1, 3, 10, 30] as const;
