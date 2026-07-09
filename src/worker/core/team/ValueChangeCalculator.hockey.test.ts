import { assert, beforeAll, test } from "vitest";
import { g, helpers } from "../../util/index.ts";
import { player, team } from "../index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { ValueChangeCalculator } from "./ValueChangeCalculator.ts";

// 2 C, 4 W, 3 D, 2 G
const POSITIONS_LAYOUT = [
	"C",
	"C",
	"W",
	"W",
	"W",
	"W",
	"D",
	"D",
	"D",
	"G",
	"G",
];

// Generate a roster with deterministic age/ovr, bypassing player.develop so positions and ratings stay exactly as set
const genRoster = (tid: number, age: number, ovr: number) =>
	POSITIONS_LAYOUT.map((pos) => {
		const p = player.generate(tid, age, 2010, true, DEFAULT_LEVEL);
		const ratings = p.ratings[0]!;
		ratings.pos = pos;
		ratings.ovr = ovr;
		ratings.pot = ovr;
		(ratings as any).ovrs = { C: ovr, W: ovr, D: ovr, G: ovr };
		(ratings as any).pots = { C: ovr, W: ovr, D: ovr, G: ovr };
		p.value = ovr;
		p.valueNoPot = ovr;
		p.valueFuzz = ovr;
		p.valueNoPotFuzz = ovr;
		p.contract.amount = g.get("minContract");

		// Expiring contracts have contractValue 0, which keeps the dv comparisons below about age multipliers only
		p.contract.exp = g.get("season");

		return p;
	});

beforeAll(async () => {
	resetG();
	g.setWithoutSavingToDB("numTeams", 4);
	g.setWithoutSavingToDB("numActiveTeams", 4);

	const teamsDefault = helpers.getTeamsDefault().slice(0, 4);

	await resetCache({
		players: [
			...genRoster(0, 30, 75), // strong and old -> winNow
			...genRoster(1, 24, 68), // strong and young -> push
			...genRoster(2, 22, 40), // weak and young, with picks -> accumulation
			...genRoster(3, 31, 38), // weak and old -> teardown
		],
		teams: teamsDefault.map((t) => team.generate(t)),
		draftPicks: [
			{
				tid: 2,
				originalTid: 2,
				round: 1,
				pick: 0,
				season: g.get("season") + 1,
			},
			{
				tid: 2,
				originalTid: 2,
				round: 1,
				pick: 0,
				season: g.get("season") + 2,
			},
		],
	});
});

test("classifies the four team archetypes", async () => {
	const calculator = new ValueChangeCalculator();

	assert.strictEqual(await calculator.getContentionPhase(0), "winNow");
	assert.strictEqual(await calculator.getContentionPhase(1), "push");
	assert.strictEqual(await calculator.getContentionPhase(2), "accumulation");
	assert.strictEqual(await calculator.getContentionPhase(3), "teardown");
});

test("a contender values an aging star more than a rebuilder does", async () => {
	const calculator = new ValueChangeCalculator();

	// pid 0 is a 30 year old star on team 0
	const trade = {
		pidsAdd: [0],
		pidsRemove: [],
		dpidsAdd: [],
		dpidsRemove: [],
		tradingPartnerTid: undefined,
	};

	const dvPush = await calculator.evaluate({ tid: 1, ...trade });
	const dvAccumulation = await calculator.evaluate({ tid: 2, ...trade });

	assert.isAbove(dvPush, 0);
	assert.isAbove(dvPush, dvAccumulation);
});
