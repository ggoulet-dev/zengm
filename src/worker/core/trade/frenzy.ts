// NHL-style trade deadline frenzy (hockey only). AI-AI trade volume ramps up
// in the final game days before the trade deadline and is halved (by design)
// the rest of the season. Over a full season, total attempt volume lands
// roughly 20% below the old flat rate, concentrated at the deadline like in
// the real NHL.

// Length of the frenzy window, in remaining-schedule game days before the deadline
export const FRENZY_WINDOW_DAYS = 10;

// Trade attempt volume multiplier on deadline day itself
export const FRENZY_PEAK_FACTOR = 4;

// Trade attempt volume multiplier outside the frenzy window (including after
// the deadline has passed) - half the normal volume
export const FRENZY_BASELINE_FACTOR = 0.5;

// Normal weight for picking a complementary trade partner (seller->buyer or
// buyer->seller) vs a random one, and the amplified weight during the frenzy
export const COMPLEMENTARY_PARTNER_WEIGHT = 3;
export const FRENZY_COMPLEMENTARY_PARTNER_WEIGHT = 8;

// During the frenzy, sellers shop their veterans even harder than usual (this
// multiplies the normal seller veteran weight)
export const FRENZY_SELLER_VETERAN_AMPLIFIER = 2;

// During the frenzy, expiring contracts on seller teams are the classic
// deadline commodity (rentals)
export const FRENZY_EXPIRING_CONTRACT_WEIGHT = 3;

/**
 * Multiplier applied to the AI-AI trade attempt rate, based on proximity to
 * the trade deadline.
 *
 * @param daysUntilDeadline Game days until the trade deadline sentinel game in
 * the remaining schedule. undefined means there is no deadline to consider
 * (deadline disabled, or no regular season schedule like during free agency)
 * so the rate is unchanged. Negative means the deadline has already passed.
 */
export const getTradeFrenzyFactor = (
	daysUntilDeadline: number | undefined,
): number => {
	if (daysUntilDeadline === undefined) {
		// No deadline -> no frenzy, but no halving either
		return 1;
	}

	if (daysUntilDeadline < 0 || daysUntilDeadline >= FRENZY_WINDOW_DAYS) {
		return FRENZY_BASELINE_FACTOR;
	}

	// Quadratic ramp from ~1x at the edge of the window up to FRENZY_PEAK_FACTOR on deadline day
	const progress = 1 - daysUntilDeadline / FRENZY_WINDOW_DAYS;
	return 1 + (FRENZY_PEAK_FACTOR - 1) * progress ** 2;
};
