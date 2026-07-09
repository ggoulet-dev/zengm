import { assert, beforeAll, test } from "vitest";
import { PHASE, PLAYER } from "../../../common/constants.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { g, helpers } from "../../util/index.ts";
import { idb } from "../../db/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { player, team } from "../index.ts";
import { resolveOfferSheet } from "./offerSheet.hockey.ts";

const SEASON = 2025;

beforeAll(async () => {
	resetG();
	g.setWithoutSavingToDB("season", SEASON);
	g.setWithoutSavingToDB("phase", PHASE.FREE_AGENCY);

	// Keep the user out of the way so both teams are AI
	g.setWithoutSavingToDB("userTid", 5);
	g.setWithoutSavingToDB("userTids", [5]);

	const teamsDefault = helpers.getTeamsDefault().slice(0, 2);
	g.setWithoutSavingToDB(
		"teamInfoCache",
		teamsDefault.map((t) => ({
			abbrev: t.abbrev,
			region: t.region,
			name: t.name,
			imgURL: undefined,
			imgURLSmall: undefined,
			disabled: false,
		})),
	);

	// The restricted free agent, tendered by team 0
	const rfa = player.generate(
		PLAYER.FREE_AGENT,
		22,
		SEASON - 4,
		true,
		DEFAULT_LEVEL,
	);
	await player.develop(rfa, 6, false, DEFAULT_LEVEL);
	rfa.born.year = SEASON - 22;
	rfa.rfaTid = 0;
	rfa.contract.amount = 4000;
	rfa.contract.exp = SEASON;

	// An expensive veteran pushing team 0 over the hard cap, so it cannot match
	const veteran = player.generate(0, 30, SEASON - 10, true, DEFAULT_LEVEL);
	await player.develop(veteran, 12, false, DEFAULT_LEVEL);
	veteran.contract.amount = 79000;
	veteran.contract.exp = SEASON + 2;

	await resetCache({
		players: [rfa, veteran],
		teams: teamsDefault.map(team.generate),
		draftPicks: [
			// Team 1's own 1st and 3rd round picks (compensation for a mid-tier offer sheet)
			{
				dpid: 1,
				tid: 1,
				originalTid: 1,
				round: 1,
				pick: 0,
				season: SEASON + 1,
			},
			{
				dpid: 2,
				tid: 1,
				originalTid: 1,
				round: 3,
				pick: 0,
				season: SEASON + 1,
			},
			// A pick team 1 acquired by trade, which must NOT be used as compensation
			{
				dpid: 3,
				tid: 1,
				originalTid: 0,
				round: 1,
				pick: 0,
				season: SEASON + 1,
			},
		],
	});
});

test("offer sheet the rights team cannot match transfers compensation picks and the player", async () => {
	const players = await idb.cache.players.indexGetAll(
		"playersByTid",
		PLAYER.FREE_AGENT,
	);
	const p = players.find((p2) => p2.rfaTid === 0);
	assert(p);

	// 5000 with an 80000 cap lands in the 1st + 3rd compensation tier, and team 0 (payroll 79000) cannot fit it under the hard cap
	const result = await resolveOfferSheet({
		p: p as any,
		offerTid: 1,
		contract: { amount: 5000, exp: SEASON + 3 },
	});

	assert.strictEqual(result, "signed");
	assert.strictEqual(p.tid, 1);
	assert.strictEqual(p.rfaTid, undefined);
	assert.strictEqual(p.contract.amount, 5000);

	// Team 1's own 1st and 3rd went to team 0; the acquired pick did not move
	const dp1 = await idb.cache.draftPicks.get(1);
	const dp2 = await idb.cache.draftPicks.get(2);
	const dp3 = await idb.cache.draftPicks.get(3);
	assert.strictEqual(dp1!.tid, 0);
	assert.strictEqual(dp2!.tid, 0);
	assert.strictEqual(dp3!.tid, 1);
});
