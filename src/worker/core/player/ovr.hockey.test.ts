import { assert, test } from "vitest";
import ovr from "./ovr.hockey.ts";
import type { PlayerRatings } from "../../../common/types.hockey.ts";

const SKATER_KEYS = [
	"hgt",
	"stre",
	"spd",
	"endu",
	"pss",
	"wst",
	"sst",
	"stk",
	"oiq",
	"chk",
	"blk",
	"fcf",
	"diq",
] as const;

const ratings = (overrides: Record<string, number>): PlayerRatings => {
	const base: Record<string, number> = { glk: 50 };
	for (const key of SKATER_KEYS) {
		base[key] = 50;
	}
	return { ...base, ...overrides } as unknown as PlayerRatings;
};

const maxedSkater = () => {
	const r: Record<string, number> = {};
	for (const key of SKATER_KEYS) {
		r[key] = 100;
	}
	return ratings(r);
};

// Truly dominant players are allowed to exceed 100 ovr. The 100 ceiling used to
// flatten every elite player to the same value; now the formula naturally tops
// out around ~121 for a maxed skater and ~115 for a maxed goalie.
test("a dominant skater exceeds 100 ovr", () => {
	assert(ovr(maxedSkater(), "C") > 100);
});

// An average-ish star still lands well under 100, so 100+ stays reserved for the
// genuinely elite rather than becoming the new normal.
test("an ordinary star stays below 100 ovr", () => {
	const r: Record<string, number> = {};
	for (const key of SKATER_KEYS) {
		r[key] = 70;
	}
	assert(ovr(ratings(r), "C") < 100);
});

// Normal goalies stay on the original glk - 10 scale so they don't out-ovr
// skaters; only a generational goalie (glk > 88) tapers up past 100.
test("a normal goalie is unchanged but a generational one exceeds 100", () => {
	// glk 80 -> 70, exactly the original scale (no inflation for typical goalies).
	assert.strictEqual(ovr(ratings({ glk: 80 }), "G"), 70);

	const elite = ovr(ratings({ glk: 100 }), "G");
	assert(elite > 100, `expected generational goalie > 100, got ${elite}`);
	assert(elite <= 110, `expected generational goalie <= 110, got ${elite}`);
});
