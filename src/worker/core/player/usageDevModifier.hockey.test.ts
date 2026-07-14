import { assert, beforeEach, describe, test } from "vitest";
import { g } from "../../util/index.ts";
import { resetG } from "../../../test/helpers.ts";
import getUsageDevModifier from "./usageDevModifier.hockey.ts";
import {
	FARM_DEV_BENCH_ROT,
	FARM_DEV_STAGNATION,
	FARM_DEV_STAGNATION_MILD,
} from "../../../common/constants.hockey.ts";

const makeP = ({
	age,
	pos = "C",
	farm = false,
	nhlGp = 0,
	min = 0,
	gpGoalie = 0,
	farmGp = 0,
	injuredGames = 0,
}: {
	age: number;
	pos?: string;
	farm?: boolean;
	nhlGp?: number;
	min?: number;
	gpGoalie?: number;
	farmGp?: number;
	injuredGames?: number;
}) => {
	const season = g.get("season");
	return {
		born: { year: season - age, loc: "" },
		ratings: [{ season, pos }],
		farm: farm || undefined,
		stats:
			nhlGp > 0 || gpGoalie > 0
				? [
						{
							season: season - 1,
							playoffs: false,
							gp: nhlGp,
							gpGoalie,
							min,
						},
					]
				: [],
		injuries:
			injuredGames > 0
				? [{ season: season - 1, games: injuredGames, type: "Sprained ankle" }]
				: [],
		farmStats:
			farmGp > 0 ? [{ season: season - 1, gp: farmGp, g: 0, a: 0 }] : undefined,
	} as any;
};

beforeEach(() => {
	resetG();
});

describe("skaters", () => {
	test("prospects on the farm and no-data players are neutral", () => {
		assert.strictEqual(getUsageDevModifier(makeP({ age: 21, farm: true })), 1);
		assert.strictEqual(getUsageDevModifier(makeP({ age: 21 })), 1);
	});

	test("pressbox rot: a young NHL spare who barely plays", () => {
		// 20 games at good minutes, never sent down: participation 20/82
		const p = makeP({ age: 21, nhlGp: 20, min: 300 });
		assert.strictEqual(getUsageDevModifier(p), FARM_DEV_BENCH_ROT);
	});

	test("a mid-season call-up's AHL games count as playing", () => {
		const p = makeP({ age: 21, nhlGp: 15, min: 225, farmGp: 50 });
		assert.strictEqual(getUsageDevModifier(p), 1);
	});

	test("full-time 4th-line rot: dressing every night for 8 minutes", () => {
		const rotted = makeP({ age: 21, nhlGp: 60, min: 480 }); // 8 min/game
		assert.strictEqual(getUsageDevModifier(rotted), FARM_DEV_BENCH_ROT);

		const regular = makeP({ age: 21, nhlGp: 60, min: 900 }); // 15 min/game
		assert.strictEqual(getUsageDevModifier(regular), 1);
	});

	test("injuries scale the participation thresholds", () => {
		// 20 games while missing half the season is a real role...
		const excused = makeP({ age: 21, nhlGp: 20, min: 300, injuredGames: 42 });
		assert.strictEqual(getUsageDevModifier(excused), 1);

		// ...the same 20 games over a full healthy season is rot (see above)
	});

	test("a season lost to injury is always neutral, even buried at 25", () => {
		const p = makeP({ age: 25, farm: true, injuredGames: 65 });
		assert.strictEqual(getUsageDevModifier(p), 1);
	});

	test("AHL stagnation ramps at 24 then 25+", () => {
		assert.strictEqual(
			getUsageDevModifier(makeP({ age: 24, farm: true })),
			FARM_DEV_STAGNATION_MILD,
		);
		assert.strictEqual(
			getUsageDevModifier(makeP({ age: 25, farm: true })),
			FARM_DEV_STAGNATION,
		);
		assert.strictEqual(
			getUsageDevModifier(makeP({ age: 28, farm: true })),
			FARM_DEV_STAGNATION,
		);
	});

	test("a real NHL role last season escapes farm stagnation", () => {
		// Sent down at the end of the year after 30 NHL games
		const p = makeP({ age: 25, farm: true, nhlGp: 30, min: 450 });
		assert.strictEqual(getUsageDevModifier(p), 1);
	});

	test("veterans off the farm are never penalized", () => {
		assert.strictEqual(
			getUsageDevModifier(makeP({ age: 25, nhlGp: 5, min: 40 })),
			1,
		);
	});
});

describe("goalies", () => {
	test("NHL backup workloads are normal usage", () => {
		const p = makeP({ age: 24, pos: "G", gpGoalie: 22, nhlGp: 22 });
		assert.strictEqual(getUsageDevModifier(p), 1);
	});

	test("third-string rot, unless AHL starts cover it", () => {
		const rotted = makeP({ age: 24, pos: "G", gpGoalie: 4, nhlGp: 4 });
		assert.strictEqual(getUsageDevModifier(rotted), FARM_DEV_BENCH_ROT);

		const covered = makeP({
			age: 24,
			pos: "G",
			gpGoalie: 4,
			nhlGp: 4,
			farmGp: 20,
		});
		assert.strictEqual(getUsageDevModifier(covered), 1);
	});

	test("goalie development window runs later: farm is fine through 25, stagnation from 26", () => {
		assert.strictEqual(
			getUsageDevModifier(makeP({ age: 25, pos: "G", farm: true })),
			1,
		);
		assert.strictEqual(
			getUsageDevModifier(makeP({ age: 26, pos: "G", farm: true })),
			FARM_DEV_STAGNATION_MILD,
		);
		assert.strictEqual(
			getUsageDevModifier(makeP({ age: 28, pos: "G", farm: true })),
			FARM_DEV_STAGNATION,
		);
	});

	test("no data is neutral", () => {
		assert.strictEqual(getUsageDevModifier(makeP({ age: 23, pos: "G" })), 1);
	});
});

test("farm system off: always neutral", () => {
	g.setWithoutSavingToDB("farmSystem", false);
	assert.strictEqual(getUsageDevModifier(makeP({ age: 25, farm: true })), 1);
	assert.strictEqual(
		getUsageDevModifier(makeP({ age: 21, nhlGp: 20, min: 300 })),
		1,
	);
});
