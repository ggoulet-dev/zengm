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

// 99 is the hard ceiling, reserved for generational players: a maxed skater's
// raw formula runs well past it and gets clamped.
test("a dominant skater is capped at 99 ovr", () => {
	assert.strictEqual(ovr(maxedSkater(), "C"), 99);
});

// An average-ish star still lands well under the cap, so 99 stays rare.
test("an ordinary star stays below 99 ovr", () => {
	const r: Record<string, number> = {};
	for (const key of SKATER_KEYS) {
		r[key] = 70;
	}
	assert(ovr(ratings(r), "C") < 99);
});

// Normal goalies stay on the original glk - 10 scale so they don't out-ovr
// skaters; only a generational goalie (glk > 88) tapers up to the 99 cap.
test("a normal goalie is unchanged but a generational one reaches the cap", () => {
	// glk 80 -> 70, exactly the original scale (no inflation for typical goalies).
	assert.strictEqual(ovr(ratings({ glk: 80 }), "G"), 70);

	assert.strictEqual(ovr(ratings({ glk: 100 }), "G"), 99);
});
