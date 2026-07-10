import { assert, beforeEach, describe, test } from "vitest";
import { g } from "../../util/index.ts";
import { resetG } from "../../../test/helpers.ts";
import {
	canSendDown,
	capHit,
	careerRegularSeasonGp,
	isFarmEligible,
	isOnFarm,
	splitFarm,
} from "./farm.hockey.ts";
import {
	FARM_CAP_RELIEF,
	FARM_ELIGIBLE_MAX_AGE,
	FARM_ELIGIBLE_MAX_CAREER_GP,
} from "../../../common/constants.hockey.ts";

const makeP = ({
	age,
	gpBySeason = [],
	playoffGpBySeason = [],
	gamesRemaining = 0,
}: {
	age: number;
	gpBySeason?: number[];
	playoffGpBySeason?: number[];
	gamesRemaining?: number;
}) =>
	({
		born: { year: g.get("season") - age, loc: "" },
		stats: [
			...gpBySeason.map((gp, i) => ({
				season: 2000 + i,
				playoffs: false,
				gp,
			})),
			...playoffGpBySeason.map((gp, i) => ({
				season: 2000 + i,
				playoffs: true,
				gp,
			})),
		],
		injury: { type: "Healthy", gamesRemaining },
	}) as any;

beforeEach(() => {
	resetG();
});

describe("isOnFarm", () => {
	test("gated by the farmSystem setting", () => {
		assert.strictEqual(isOnFarm({ farm: true }), true);
		assert.strictEqual(isOnFarm({}), false);

		// Disabling the setting turns leftover farm players back into actives
		g.setWithoutSavingToDB("farmSystem", false);
		assert.strictEqual(isOnFarm({ farm: true }), false);
	});
});

describe("isFarmEligible (simplified waiver exemption)", () => {
	test("young players are always eligible, even with many games", () => {
		const p = makeP({
			age: FARM_ELIGIBLE_MAX_AGE,
			gpBySeason: [82, 82, 82, 82],
		});
		assert.strictEqual(isFarmEligible(p), true);
	});

	test("older players are eligible only below the career games threshold", () => {
		const inexperienced = makeP({
			age: FARM_ELIGIBLE_MAX_AGE + 5,
			gpBySeason: [80, FARM_ELIGIBLE_MAX_CAREER_GP - 81],
		});
		assert.strictEqual(isFarmEligible(inexperienced), true);

		const veteran = makeP({
			age: FARM_ELIGIBLE_MAX_AGE + 5,
			gpBySeason: [80, FARM_ELIGIBLE_MAX_CAREER_GP - 80],
		});
		assert.strictEqual(isFarmEligible(veteran), false);
	});

	test("playoff games don't count toward the threshold", () => {
		const p = makeP({
			age: FARM_ELIGIBLE_MAX_AGE + 5,
			gpBySeason: [100],
			playoffGpBySeason: [100],
		});
		assert.strictEqual(careerRegularSeasonGp(p), 100);
		assert.strictEqual(isFarmEligible(p), true);
	});
});

describe("canSendDown", () => {
	test("injured players can't be assigned to the farm", () => {
		const p = makeP({ age: 20, gamesRemaining: 5 });
		assert.strictEqual(canSendDown(p), false);

		const healthy = makeP({ age: 20 });
		assert.strictEqual(canSendDown(healthy), true);
	});
});

describe("capHit (buried-contract relief)", () => {
	test("active players count in full", () => {
		assert.strictEqual(capHit(5000, undefined), 5000);
		assert.strictEqual(capHit(5000, false), 5000);
	});

	test("farm players get relief, floored at zero", () => {
		assert.strictEqual(capHit(5000, true), 5000 - FARM_CAP_RELIEF);
		assert.strictEqual(capHit(g.get("minContract"), true), 0);
	});

	test("no relief when the farm system is disabled", () => {
		g.setWithoutSavingToDB("farmSystem", false);
		assert.strictEqual(capHit(5000, true), 5000);
	});
});

describe("splitFarm", () => {
	test("partitions by flag, respecting the setting", () => {
		const players = [{ farm: true }, {}, { farm: true }, { farm: false }];
		const { active, farm } = splitFarm(players);
		assert.strictEqual(active.length, 2);
		assert.strictEqual(farm.length, 2);

		g.setWithoutSavingToDB("farmSystem", false);
		const all = splitFarm(players);
		assert.strictEqual(all.active.length, 4);
		assert.strictEqual(all.farm.length, 0);
	});
});
