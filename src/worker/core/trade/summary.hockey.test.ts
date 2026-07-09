import { assert, beforeAll, test } from "vitest";
import { g } from "../../util/index.ts";
import { player } from "../index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import summary from "./summary.ts";
import type { TradeTeams } from "../../../common/types.ts";

// Roster with exactly the minimum number of players at each position required by the trade position check, see MIN_PLAYERS_BY_POS in summary.ts
const POSITIONS_FULL = ["C", "C", "W", "W", "W", "W", "D", "D", "D", "G", "G"];

// Same, but with only 1 goalie (already below the minimum)
const POSITIONS_ONE_GOALIE = POSITIONS_FULL.slice(0, -1);

const genPlayers = (tid: number, positions: string[]) =>
	positions.map((pos) => {
		const p = player.generate(tid, 25, 2017, true, DEFAULT_LEVEL);
		p.ratings[0]!.pos = pos;

		// Min contracts, so the salary cap warning never fires
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

// pids are assigned sequentially from 0, in the order players are added to the cache below
const PIDS = {
	team0: { w: 2, g: 9 },
	team1: { w: 13, g: 20 },
	team2: { w: 24 },
};

beforeAll(async () => {
	resetG();

	await resetCache({
		players: [
			...genPlayers(0, POSITIONS_FULL),
			...genPlayers(1, POSITIONS_FULL),
			...genPlayers(2, POSITIONS_ONE_GOALIE),
		],
	});
});

test("blocks a trade leaving a team with too few goalies", async () => {
	const s = await summary(
		makeTradeTeams([0, [PIDS.team0.g]], [1, [PIDS.team1.w]]),
	);

	assert.isString(s.warning);
	assert.include(s.warning!, "G (would have 1, needs 2)");

	// The team named in the warning must be the one losing the goalie
	assert.include(s.warning!, g.get("teamInfoCache")[0]!.region);
});

test("allows a 1-for-1 goalie swap", async () => {
	const s = await summary(
		makeTradeTeams([0, [PIDS.team0.g]], [1, [PIDS.team1.g]]),
	);

	assert.isNull(s.warning);
});

test("allows a normal skater trade", async () => {
	const s = await summary(
		makeTradeTeams([0, [PIDS.team0.w]], [1, [PIDS.team1.w]]),
	);

	assert.isNull(s.warning);
});

test("does not block unrelated trades for a team already below the minimum", async () => {
	// Team 2 only has 1 goalie, but this trade does not make that worse
	const s = await summary(
		makeTradeTeams([2, [PIDS.team2.w]], [0, [PIDS.team0.w]]),
	);

	assert.isNull(s.warning);
});
