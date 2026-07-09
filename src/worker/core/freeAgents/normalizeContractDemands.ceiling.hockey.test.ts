import { assert, beforeEach, test } from "vitest";
import { player, team } from "../index.ts";
import { idb } from "../../db/index.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { PLAYER } from "../../../common/constants.ts";
import normalizeContractDemands from "./normalizeContractDemands.ts";

const SEASON = 2025;
const NUM_TEAMS = 16;

const makePlayer = async (tid: number, age: number) => {
	const draftYear = SEASON - (age - 18);
	const p = player.generate(tid, age, draftYear, true, DEFAULT_LEVEL);
	await player.develop(p, Math.max(1, age - 18), false, DEFAULT_LEVEL);
	p.tid = tid;
	return p;
};

beforeEach(() => {
	resetG();
	g.setWithoutSavingToDB("season", SEASON);
});

// Regression for the hockey free-agency auction running away in a cap-rich
// league. Without the value-based ceiling, the bidding loop inflates even
// mid-tier free agents all the way to the max contract. With it, only genuine
// stars (whose genContract already sits near the max) can reach the max.
test("a cap-rich hockey league does not bid mid-tier free agents up to the max contract", async () => {
	const teamsDefault = helpers.getTeamsDefault().slice(0, NUM_TEAMS);
	const allPlayers: any[] = [];

	// Deliberately thin, cheap rosters => lots of league-wide cap space, which is
	// exactly the condition that makes the auction explode.
	for (let tid = 0; tid < NUM_TEAMS; tid++) {
		for (let i = 0; i < 12; i++) {
			allPlayers.push(
				await makePlayer(tid, 24 + Math.floor(Math.random() * 8)),
			);
		}
	}

	// A pool of mid-tier free agents (value ~65) plus a couple of genuine stars.
	const midFas: any[] = [];
	for (let i = 0; i < 40; i++) {
		const p = await makePlayer(
			PLAYER.FREE_AGENT,
			25 + Math.floor(Math.random() * 5),
		);
		p.tid = PLAYER.FREE_AGENT;
		(p as any)._targetValue = 63 + Math.random() * 4; // 63-67
		midFas.push(p);
		allPlayers.push(p);
	}
	const stars: any[] = [];
	for (let i = 0; i < 3; i++) {
		const p = await makePlayer(PLAYER.FREE_AGENT, 26);
		p.tid = PLAYER.FREE_AGENT;
		(p as any)._targetValue = 86;
		stars.push(p);
		allPlayers.push(p);
	}

	await resetCache({
		players: allPlayers,
		teams: teamsDefault.map(team.generate),
		teamSeasons: teamsDefault.map((t) => team.genSeasonRow(t)),
		teamStats: teamsDefault.map((t) => team.genStatsRow(t.tid)),
	});

	for (const p of await idb.cache.players.getAll()) {
		await player.updateValues(p);
		if ((p as any)._targetValue !== undefined) {
			p.value = (p as any)._targetValue;
		}
		// Cheap existing contracts on rostered players -> big cap space
		if (p.tid >= 0) {
			p.contract = { amount: 1500, exp: SEASON + 2 };
		} else {
			p.contract = player.genContract(p, false);
		}
		await idb.cache.players.put(p);
	}

	await normalizeContractDemands({ type: "freeAgentsOnly" });

	const maxContract = g.get("maxContract");
	const after = (await idb.cache.players.getAll()).filter(
		(p) => p.tid === PLAYER.FREE_AGENT,
	);
	const midAmounts = after
		.filter((p) => p.value < 70)
		.map((p) => p.contract.amount);

	// Sanity: the league really is cap-rich (otherwise the test proves nothing).
	let totalCapSpace = 0;
	for (let tid = 0; tid < NUM_TEAMS; tid++) {
		totalCapSpace += g.get("salaryCap") - (await team.getPayroll(tid));
	}
	assert.isAbove(totalCapSpace, 10 * maxContract);

	// No mid-tier free agent should be anywhere near the max contract.
	const numNearMax = midAmounts.filter((a) => a >= 0.85 * maxContract).length;
	assert.strictEqual(
		numNearMax,
		0,
		`mid-tier FAs should not approach the max; ${numNearMax} did (amounts: ${midAmounts.join(", ")})`,
	);

	// The median mid-tier demand should be comfortably below the max.
	const sorted = [...midAmounts].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)]!;
	assert.isBelow(median, 0.7 * maxContract);

	// Every demand must respect the value-based ceiling (the mechanism itself).
	for (const p of after) {
		const ceiling = player.genContract(p, false, true).amount * 1.25;
		assert.isAtMost(
			p.contract.amount,
			helpers.bound(helpers.roundContract(ceiling), 0, maxContract) + 1,
		);
	}
});
