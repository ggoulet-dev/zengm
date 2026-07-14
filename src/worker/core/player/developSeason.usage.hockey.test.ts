import { assert, afterEach, beforeEach, test } from "vitest";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { g, helpers } from "../../util/index.ts";
import { resetG } from "../../../test/helpers.ts";
import { player } from "../index.ts";
import developSeason from "./developSeason.hockey.ts";

// Deterministic RNG, same generator as franchise10yr.hockey.test.ts
const mulberry32 = (seed: number) => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const originalRandom = Math.random;

beforeEach(() => {
	resetG();
});

afterEach(() => {
	Math.random = originalRandom;
});

const genRatings = (seed: number) => {
	Math.random = mulberry32(seed);
	const p = player.generate(0, 21, g.get("season") - 2, true, DEFAULT_LEVEL);
	return p.ratings[0]!;
};

const RATING_KEYS = [
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
	"glk",
] as const;

test("neutral path is bit-identical: omitted modifier vs explicit 1", () => {
	for (const seed of [1, 2, 3, 4, 5]) {
		const r1 = genRatings(seed);
		const r2 = helpers.deepCopy(r1);

		Math.random = mulberry32(seed + 1000);
		developSeason(r1 as any, 21, DEFAULT_LEVEL);

		Math.random = mulberry32(seed + 1000);
		developSeason(r2 as any, 21, DEFAULT_LEVEL, 1);

		assert.deepStrictEqual(r1, r2, `seed ${seed}`);
	}
});

test("a penalized young player never beats his same-seed control on any rating", () => {
	let sumControl = 0;
	let sumPenalized = 0;

	for (let seed = 0; seed < 200; seed++) {
		const control = genRatings(seed);
		const penalized = helpers.deepCopy(control);

		// Three development seasons, ages 21-23, identical RNG streams
		for (let age = 21; age <= 23; age++) {
			Math.random = mulberry32(seed * 10 + age);
			developSeason(control as any, age, DEFAULT_LEVEL, 1);
		}
		for (let age = 21; age <= 23; age++) {
			Math.random = mulberry32(seed * 10 + age);
			developSeason(penalized as any, age, DEFAULT_LEVEL, 0.8);
		}

		for (const key of RATING_KEYS) {
			assert.isAtMost(
				(penalized as any)[key],
				(control as any)[key],
				`seed ${seed}, rating ${key}`,
			);
			sumControl += (control as any)[key];
			sumPenalized += (penalized as any)[key];
		}
	}

	// And the effect is material in aggregate, not a rounding artifact
	assert.isBelow(sumPenalized, sumControl * 0.995);
});

test("decline is never touched: at 40 the penalized and control paths are identical", () => {
	// At 40 the age band is -4 and the noise tail tops out at +4, so the positive branch can never fire
	for (const seed of [11, 12, 13]) {
		const control = genRatings(seed);
		const penalized = helpers.deepCopy(control);

		Math.random = mulberry32(seed + 2000);
		developSeason(control as any, 40, DEFAULT_LEVEL, 1);

		Math.random = mulberry32(seed + 2000);
		developSeason(penalized as any, 40, DEFAULT_LEVEL, 0.8);

		assert.deepStrictEqual(penalized, control, `seed ${seed}`);
	}
});
