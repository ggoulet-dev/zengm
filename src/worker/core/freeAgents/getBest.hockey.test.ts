import { assert, beforeEach, describe, test } from "vitest";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { g } from "../../util/index.ts";
import { resetG } from "../../../test/helpers.ts";
import { player } from "../index.ts";
import getBest, { getAiRosterTarget } from "./getBest.ts";

// Hockey POSITION_COUNTS: C 5, W 10, D 7, G 3 (functional roster of 25)
const makePlayer = (pos: string, amount: number, value = 50) => {
	const p = player.generate(0, 25, 2010, true, DEFAULT_LEVEL);
	const ratings = p.ratings[0]!;
	ratings.pos = pos;
	ratings.ovr = value;
	ratings.pot = value;
	(ratings as any).ovrs = { C: value, W: value, D: value, G: value };
	(ratings as any).pots = { C: value, W: value, D: value, G: value };
	p.value = value;
	p.contract.amount = amount;
	p.contract.exp = g.get("season") + 2;
	return p;
};

const makeRoster = (counts: Record<string, number>) => {
	const players = [];
	for (const [pos, count] of Object.entries(counts)) {
		for (let i = 0; i < count; i++) {
			players.push(makePlayer(pos, 2000, 60));
		}
	}
	return players;
};

beforeEach(() => {
	resetG();
});

describe("getAiRosterTarget", () => {
	test("default league: capped by the NHL-style active roster limit", () => {
		// Hockey defaults: maxRosterSize 23, minRosterSize 20 (active roster limits with the farm system)
		assert.strictEqual(getAiRosterTarget(), 21);
	});

	test("NHL 50-contract league: functional roster, not maxRosterSize - 2", () => {
		g.setWithoutSavingToDB("maxRosterSize", 50);
		g.setWithoutSavingToDB("minRosterSize", 20);
		assert.strictEqual(getAiRosterTarget(), 27);
	});

	test("never below minRosterSize + 2, to avoid fighting the auto-fill", () => {
		g.setWithoutSavingToDB("maxRosterSize", 50);
		g.setWithoutSavingToDB("minRosterSize", 40);
		assert.strictEqual(getAiRosterTarget(), 42);
	});
});

describe("getBest roster discipline in large-roster leagues", () => {
	beforeEach(() => {
		g.setWithoutSavingToDB("maxRosterSize", 50);
		g.setWithoutSavingToDB("minRosterSize", 20);
		// getAiRosterTarget() is 27 here
	});

	test("min-contract filler stops at the AI roster target instead of maxRosterSize - 2", () => {
		const minContract = g.get("minContract");
		const pool = [makePlayer("W", minContract)];

		const rosterAtTarget = makeRoster({ C: 5, W: 9, D: 8, G: 5 }); // 27
		assert.strictEqual(getBest(rosterAtTarget, pool, 0), undefined);

		const rosterBelowTarget = makeRoster({ C: 5, W: 9, D: 8, G: 4 }); // 26
		assert.strictEqual(getBest(rosterBelowTarget, pool, 0), pool[0]);
	});

	test("min-contract filler skips a position already at its POSITION_COUNTS share", () => {
		const minContract = g.get("minContract");
		const roster = makeRoster({ C: 5, W: 8, D: 4, G: 3 }); // 20, C and G full

		assert.strictEqual(
			getBest(roster, [makePlayer("C", minContract)], 0),
			undefined,
		);
		assert.strictEqual(
			getBest(roster, [makePlayer("G", minContract)], 0),
			undefined,
		);

		const poolD = [makePlayer("D", minContract)];
		assert.strictEqual(getBest(roster, poolD, 0), poolD[0]);
	});

	test("normal signings stop a few spots above the AI roster target", () => {
		const pool = [makePlayer("W", 3000, 70)];

		const rosterFull = makeRoster({ C: 6, W: 12, D: 8, G: 4 }); // 30 = target + 3
		assert.strictEqual(getBest(rosterFull, pool, 0), undefined);

		const rosterAlmostFull = makeRoster({ C: 6, W: 11, D: 8, G: 4 }); // 29
		assert.strictEqual(getBest(rosterAlmostFull, pool, 0), pool[0]);
	});

	test("key position override still fires: a team with one goalie signs one no matter what", () => {
		const minContract = g.get("minContract");
		const roster = makeRoster({ C: 8, W: 13, D: 9, G: 1 }); // 31, over everything
		const pool = [makePlayer("G", minContract)];

		assert.strictEqual(getBest(roster, pool, 0), pool[0]);
	});
});

describe("getBest position balance in a default-size league", () => {
	// Hockey defaults: maxRosterSize 23, minRosterSize 20, getAiRosterTarget() 21.
	// The positionFull gate is a deliberate change from upstream (which would
	// stack an 11th winger as filler); it keeps AI rosters position-balanced.
	test("min-contract filler skips a full position even below the roster target", () => {
		const minContract = g.get("minContract");
		const roster = makeRoster({ C: 3, W: 10, D: 4, G: 2 }); // 19 < target 21, W full

		assert.strictEqual(
			getBest(roster, [makePlayer("W", minContract)], 0),
			undefined,
		);

		const poolC = [makePlayer("C", minContract)];
		assert.strictEqual(getBest(roster, poolC, 0), poolC[0]);
	});

	test("farm players don't count toward any roster-size gate", () => {
		const minContract = g.get("minContract");
		const roster = makeRoster({ C: 3, W: 9, D: 4, G: 2 }); // 18 active < target 21
		for (let i = 0; i < 25; i++) {
			// A full farm of prospects must not satisfy the size checks and kill AI free agency
			const p = makePlayer("W", minContract, 40);
			p.farm = true;
			roster.push(p);
		}

		const poolC = [makePlayer("C", minContract)];
		assert.strictEqual(getBest(roster, poolC, 0), poolC[0]);
	});
});
