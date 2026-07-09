import { assert, beforeEach, describe, test } from "vitest";
import { g } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import {
	countAccruedSeasons,
	getRfaRightsTid,
	isRfaEligible,
	tenderQualifyingOffer,
	RFA_DEMAND_FACTOR,
} from "./rfa.hockey.ts";
import {
	findCompensationPicks,
	getOfferSheetCompensationRounds,
} from "./offerSheet.hockey.ts";

const SEASON = 2025;

const makePlayer = ({
	age = 24,
	pos = "C",
	gpBySeason = [],
	rfaTid,
}: {
	age?: number;
	pos?: string;
	gpBySeason?: number[];
	rfaTid?: number;
}) =>
	({
		born: { year: SEASON - age },
		ratings: [{ pos }],
		stats: gpBySeason.map((gp, i) => ({
			season: SEASON - gpBySeason.length + i,
			gp,
			playoffs: false,
		})),
		contract: { amount: 4000, exp: SEASON },
		value: 60,
		rfaTid,
	}) as any;

beforeEach(() => {
	resetG();
	g.setWithoutSavingToDB("season", SEASON);
});

describe("countAccruedSeasons", () => {
	test("skater needs 40 games for an accrued season", () => {
		const p = makePlayer({ gpBySeason: [82, 40, 39, 12] });
		assert.strictEqual(countAccruedSeasons(p), 2);
	});

	test("goalie needs only 30 games", () => {
		const p = makePlayer({ pos: "G", gpBySeason: [35, 29] });
		assert.strictEqual(countAccruedSeasons(p), 1);
	});

	test("a season split across two stats rows (trade) is summed", () => {
		const p = makePlayer({});
		p.stats = [
			{ season: SEASON - 1, gp: 25, playoffs: false },
			{ season: SEASON - 1, gp: 20, playoffs: false },
			{ season: SEASON - 1, gp: 10, playoffs: true },
		];
		assert.strictEqual(countAccruedSeasons(p), 1);
	});
});

describe("isRfaEligible", () => {
	test("young player with few accrued seasons is restricted", () => {
		assert.strictEqual(
			isRfaEligible(makePlayer({ age: 24, gpBySeason: [82, 82, 82] })),
			true,
		);
	});

	test("age 27 is unrestricted", () => {
		assert.strictEqual(
			isRfaEligible(makePlayer({ age: 27, gpBySeason: [82, 82] })),
			false,
		);
	});

	test("7 accrued seasons is unrestricted even when young", () => {
		assert.strictEqual(
			isRfaEligible(
				makePlayer({ age: 25, gpBySeason: [82, 82, 82, 82, 82, 82, 82] }),
			),
			false,
		);
		assert.strictEqual(
			isRfaEligible(
				makePlayer({ age: 25, gpBySeason: [82, 82, 82, 82, 82, 82, 39] }),
			),
			true,
		);
	});

	test("disabled by the rfa setting", () => {
		g.setWithoutSavingToDB("rfa", false);
		assert.strictEqual(isRfaEligible(makePlayer({ age: 24 })), false);
	});
});

describe("getRfaRightsTid", () => {
	test("returns the rights team for a tendered eligible player", () => {
		const p = makePlayer({ age: 24, rfaTid: 7 });
		assert.strictEqual(getRfaRightsTid(p), 7);
	});

	test("rights lapse when the player ages out", () => {
		const p = makePlayer({ age: 27, rfaTid: 7 });
		assert.strictEqual(getRfaRightsTid(p), undefined);
	});

	test("no rights without a tender", () => {
		const p = makePlayer({ age: 24 });
		assert.strictEqual(getRfaRightsTid(p), undefined);
	});
});

describe("tenderQualifyingOffer", () => {
	test("sets rights and discounts the asking price to a bridge deal", () => {
		const p = makePlayer({ age: 24 });
		p.contract.amount = 4000;
		tenderQualifyingOffer(p, 3);
		assert.strictEqual(p.rfaTid, 3);
		assert.strictEqual(p.contract.amount, 4000 * RFA_DEMAND_FACTOR);
	});

	test("never goes below the minimum contract", () => {
		const p = makePlayer({ age: 24 });
		p.contract.amount = g.get("minContract");
		tenderQualifyingOffer(p, 3);
		assert.strictEqual(p.contract.amount, g.get("minContract"));
	});
});

describe("getOfferSheetCompensationRounds", () => {
	test("maps contract size to NHL compensation tiers, scaled by the cap", () => {
		g.setWithoutSavingToDB("salaryCap", 80000);
		assert.deepStrictEqual(getOfferSheetCompensationRounds(1000), []);
		assert.deepStrictEqual(getOfferSheetCompensationRounds(1500), [3]);
		assert.deepStrictEqual(getOfferSheetCompensationRounds(3000), [2]);
		assert.deepStrictEqual(getOfferSheetCompensationRounds(5000), [1, 3]);
		assert.deepStrictEqual(getOfferSheetCompensationRounds(7000), [1, 2, 3]);
		assert.deepStrictEqual(getOfferSheetCompensationRounds(9000), [1, 1, 2, 3]);
		assert.deepStrictEqual(
			getOfferSheetCompensationRounds(12000),
			[1, 1, 1, 1],
		);
	});
});

describe("findCompensationPicks", () => {
	test("returns the team's own picks, earliest seasons first", async () => {
		await resetCache({
			draftPicks: [
				// Own 1sts in two future drafts
				{ dpid: 1, tid: 0, originalTid: 0, round: 1, pick: 0, season: 2027 },
				{ dpid: 2, tid: 0, originalTid: 0, round: 1, pick: 0, season: 2026 },
				// Another team's 1st, acquired by trade - NOT usable as compensation
				{ dpid: 3, tid: 0, originalTid: 5, round: 1, pick: 0, season: 2026 },
				// Own 3rd
				{ dpid: 4, tid: 0, originalTid: 0, round: 3, pick: 0, season: 2026 },
			],
		});

		const picks = await findCompensationPicks(0, [1, 3]);
		assert(picks);
		assert.deepStrictEqual(
			picks.map((dp) => dp.dpid),
			[2, 4],
		);
	});

	test("multiple picks in the same round come from consecutive drafts", async () => {
		await resetCache({
			draftPicks: [
				{ dpid: 1, tid: 0, originalTid: 0, round: 1, pick: 0, season: 2028 },
				{ dpid: 2, tid: 0, originalTid: 0, round: 1, pick: 0, season: 2026 },
				{ dpid: 3, tid: 0, originalTid: 0, round: 2, pick: 0, season: 2026 },
				{ dpid: 4, tid: 0, originalTid: 0, round: 3, pick: 0, season: 2026 },
			],
		});

		const picks = await findCompensationPicks(0, [1, 1, 2, 3]);
		assert(picks);
		assert.deepStrictEqual(picks.map((dp) => dp.dpid).sort(), [1, 2, 3, 4]);
	});

	test("undefined when an own pick was traded away", async () => {
		await resetCache({
			draftPicks: [
				// Own 1st now belongs to team 5
				{ dpid: 1, tid: 5, originalTid: 0, round: 1, pick: 0, season: 2026 },
				{ dpid: 2, tid: 0, originalTid: 0, round: 3, pick: 0, season: 2026 },
			],
		});

		assert.strictEqual(await findCompensationPicks(0, [1, 3]), undefined);
	});

	test("undefined when the league has fewer draft rounds than required", async () => {
		await resetCache({ draftPicks: [] });
		g.setWithoutSavingToDB("numDraftRounds", 2);
		assert.strictEqual(await findCompensationPicks(0, [1, 3]), undefined);
	});

	test("empty rounds need no picks", async () => {
		await resetCache({ draftPicks: [] });
		assert.deepStrictEqual(await findCompensationPicks(0, []), []);
	});
});
