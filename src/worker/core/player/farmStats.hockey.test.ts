import { assert, afterEach, beforeEach, describe, test } from "vitest";
import { g } from "../../util/index.ts";
import { resetG } from "../../../test/helpers.ts";
import {
	accrueFarmGameDay,
	sampleFarmGoalieGame,
	sampleFarmSkaterGame,
} from "./farmStats.hockey.ts";

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
	Math.random = mulberry32(20260714);
});

afterEach(() => {
	Math.random = originalRandom;
});

describe("sampling lands in AHL-plausible ranges", () => {
	test("skaters: an AHL first-liner produces around a point per game", () => {
		const N = 2000;

		let ptsForward = 0;
		let ptsD = 0;
		for (let i = 0; i < N; i++) {
			const f = sampleFarmSkaterGame(55, "C");
			ptsForward += f.g + f.a;
			const d = sampleFarmSkaterGame(55, "D");
			ptsD += d.g + d.a;
		}

		// ovr 55 -> expected 1.0 ppg for forwards, x0.55 for defensemen
		assert.closeTo(ptsForward / N, 1.0, 0.12);
		assert.closeTo(ptsD / N, 0.55, 0.1);
	});

	test("goalies: save percentage tracks glk within the AHL band", () => {
		const N = 2000;

		const svPctFor = (glk: number) => {
			let sv = 0;
			let ga = 0;
			for (let i = 0; i < N; i++) {
				const game = sampleFarmGoalieGame(glk);
				sv += game.sv;
				ga += game.ga;
			}
			return sv / (sv + ga);
		};

		const low = svPctFor(40);
		const high = svPctFor(70);
		assert.closeTo(low, 0.87, 0.012);
		assert.closeTo(high, 0.906, 0.012);
		assert.isBelow(low, high);
	});
});

describe("accrueFarmGameDay", () => {
	const makeP = (pos: string) =>
		({
			ratings: [{ season: g.get("season"), pos, ovr: 55, glk: 55 }],
			farmStats: undefined,
		}) as any;

	test("creates and increments the current-season row at roughly the game probability", () => {
		const p = makeP("C");
		const days = 500;
		let played = 0;
		for (let i = 0; i < days; i++) {
			if (accrueFarmGameDay(p)) {
				played += 1;
			}
		}

		assert.strictEqual(p.farmStats!.length, 1);
		const row = p.farmStats![0]!;
		assert.strictEqual(row.season, g.get("season"));
		assert.strictEqual(row.gp, played);
		// FARM_STATS_GAME_PROB = 0.85
		assert.closeTo(played / days, 0.85, 0.05);
		assert.isAbove(row.g + row.a, 0);
		assert.isUndefined(row.sv);
	});

	test("goalies accrue less often and fill sv/ga instead of g/a", () => {
		const p = makeP("G");
		const days = 500;
		for (let i = 0; i < days; i++) {
			accrueFarmGameDay(p);
		}

		const row = p.farmStats![0]!;
		// FARM_STATS_GOALIE_GAME_PROB = 0.425
		assert.closeTo(row.gp / days, 0.425, 0.05);
		assert.isAbove(row.sv!, 0);
		assert.strictEqual(row.g, 0);
		assert.strictEqual(row.a, 0);
	});

	test("season rollover starts a new row and preserves history", () => {
		const p = makeP("C");
		for (let i = 0; i < 50; i++) {
			accrueFarmGameDay(p);
		}
		const gpFirstSeason = p.farmStats![0]!.gp;

		g.setWithoutSavingToDB("season", g.get("season") + 1);
		for (let i = 0; i < 50; i++) {
			accrueFarmGameDay(p);
		}

		assert.strictEqual(p.farmStats!.length, 2);
		assert.strictEqual(p.farmStats![0]!.gp, gpFirstSeason);
		assert.isAbove(p.farmStats![1]!.gp, 0);
		assert.strictEqual(p.farmStats![1]!.season, g.get("season"));
	});
});
