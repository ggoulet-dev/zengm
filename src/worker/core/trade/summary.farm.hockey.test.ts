import { assert, beforeAll, test } from "vitest";
import { g } from "../../util/index.ts";
import { player } from "../index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import summary from "./summary.ts";
import { FARM_CAP_RELIEF } from "../../../common/constants.hockey.ts";
import type { TradeTeams } from "../../../common/types.ts";

// Legal position minimums for the trade check, see summary.hockey.test.ts
const POSITIONS_FULL = ["C", "C", "W", "W", "W", "W", "D", "D", "D", "G", "G"];

const genPlayers = (tid: number, positions: string[]) =>
	positions.map((pos) => {
		const p = player.generate(tid, 25, 2017, true, DEFAULT_LEVEL);
		p.ratings[0]!.pos = pos;
		p.contract.amount = g.get("minContract");
		return p;
	});

const makeTradeTeams = (
	[tid0, pids0]: [number, number[]],
	[tid1, pids1]: [number, number[]],
): TradeTeams => [
	{ tid: tid0, pids: pids0, pidsExcluded: [], dpids: [], dpidsExcluded: [] },
	{ tid: tid1, pids: pids1, pidsExcluded: [], dpids: [], dpidsExcluded: [] },
];

const BURIED_SALARY = 5000;

// pids are assigned sequentially from 0 in cache-add order
const PIDS = {
	team0: { w: 2, buried: 11 },
	team1: { w: 14 },
};

beforeAll(async () => {
	resetG();

	const buriedProspect = player.generate(0, 22, 2017, true, DEFAULT_LEVEL);
	buriedProspect.ratings[0]!.pos = "W";
	buriedProspect.contract.amount = BURIED_SALARY;
	buriedProspect.farm = true;

	await resetCache({
		players: [
			...genPlayers(0, POSITIONS_FULL),
			buriedProspect,
			...genPlayers(1, POSITIONS_FULL),
		],
	});
});

test("payrollAfterTrade uses cap hits: buried relief travels with the traded player", async () => {
	const s = await summary(
		makeTradeTeams([0, [PIDS.team0.buried]], [1, [PIDS.team1.w]]),
	);

	const minContract = g.get("minContract");

	// Team 0 before: 11 min contracts + buried (salary - relief)
	const before0 = (11 * minContract + (BURIED_SALARY - FARM_CAP_RELIEF)) / 1000;
	assert.closeTo(s.teams[0].payrollBeforeTrade, before0, 1e-9);

	// Team 0 after: loses the buried player's CAP HIT (not his full salary), gains a min contract
	const after0 =
		before0 - (BURIED_SALARY - FARM_CAP_RELIEF) / 1000 + minContract / 1000;
	assert.closeTo(s.teams[0].payrollAfterTrade, after0, 1e-9);

	// Team 1 after: gains the buried player's cap hit (the farm flag rides along), loses a min contract
	const before1 = (11 * minContract) / 1000;
	const after1 =
		before1 + (BURIED_SALARY - FARM_CAP_RELIEF) / 1000 - minContract / 1000;
	assert.closeTo(s.teams[1].payrollBeforeTrade, before1, 1e-9);
	assert.closeTo(s.teams[1].payrollAfterTrade, after1, 1e-9);

	// The displayed trade total keeps showing the real salary, not the cap hit
	assert.closeTo(s.teams[0].total, BURIED_SALARY / 1000, 1e-9);
});

test("without farm players, cap-hit totals match raw totals", async () => {
	const s = await summary(
		makeTradeTeams([0, [PIDS.team0.w]], [1, [PIDS.team1.w]]),
	);

	const minContract = g.get("minContract") / 1000;
	assert.closeTo(
		s.teams[0].payrollAfterTrade,
		s.teams[0].payrollBeforeTrade + minContract - minContract,
		1e-9,
	);
	assert.isNull(s.warning);
});
