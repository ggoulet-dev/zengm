import { assert, describe, test } from "vitest";
import { PLAYER } from "../../../common/constants.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { g, helpers } from "../../util/index.ts";
import { idb } from "../../db/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { player, team } from "../index.ts";
import checkRosterSizes from "./checkRosterSizes.ts";
import { last } from "../../../common/utils.ts";

const makePlayer = (
	tid: number,
	pos: string,
	amount: number,
	value: number,
	injured = false,
) => {
	const p = player.generate(tid, 25, 2010, true, DEFAULT_LEVEL);
	const ratings = p.ratings[0]!;
	ratings.pos = pos;
	ratings.ovr = value;
	ratings.pot = value;
	(ratings as any).ovrs = { C: value, W: value, D: value, G: value };
	(ratings as any).pots = { C: value, W: value, D: value, G: value };
	p.value = value;
	p.contract.amount = amount;
	p.contract.exp = g.get("season") + 2;
	if (injured) {
		p.injury = { type: "Sprained ankle", gamesRemaining: 10 };
	}
	return p;
};

// counts: [total, numMinContract] per position
const makeRoster = (tid: number, counts: Record<string, [number, number]>) => {
	const minContract = g.get("minContract");
	const players = [];
	let minValue = 30;
	for (const [pos, [total, numMin]] of Object.entries(counts)) {
		for (let i = 0; i < total; i++) {
			const isMin = i < numMin;
			players.push(
				makePlayer(
					tid,
					pos,
					isMin ? minContract : 2000,
					isMin ? minValue++ : 60,
				),
			);
		}
	}
	return players;
};

const setup = async (counts: Record<string, [number, number]>) => {
	resetG();
	// This suite is the regression coverage for the farm-system-OFF path (the trim only exists for 50-contract leagues without a farm)
	g.setWithoutSavingToDB("farmSystem", false);
	g.setWithoutSavingToDB("maxRosterSize", 50);
	g.setWithoutSavingToDB("minRosterSize", 20);
	g.setWithoutSavingToDB("numTeams", 2);
	g.setWithoutSavingToDB("numActiveTeams", 2);

	// Team 1 is the user, so team 0 takes the AI path
	g.setWithoutSavingToDB("userTid", 1);
	g.setWithoutSavingToDB("userTids", [1]);

	const teamsDefault = helpers.getTeamsDefault().slice(0, 2);
	await resetCache({
		players: [
			...makeRoster(0, counts),
			...makeRoster(1, { C: [5, 0], W: [10, 0], D: [7, 0], G: [3, 0] }),
		],
		teams: teamsDefault.map((t) => team.generate(t)),
	});
};

const getRoster = async (tid: number) =>
	idb.cache.players.indexGetAll("playersByTid", tid);

const countByPos = (players: { ratings: { pos: string }[] }[]) => {
	const counts: Record<string, number> = {};
	for (const p of players) {
		const pos = last(p.ratings as [{ pos: string }]).pos;
		counts[pos] = (counts[pos] ?? 0) + 1;
	}
	return counts;
};

describe("AI roster trim in large-roster leagues", () => {
	test("trims min-contract surplus down to the AI roster target, lowest value first from overfull positions", async () => {
		// 33 players, target 27 => 6 to drop. C is the most overfull and its filler
		// is the lowest value, so all 6 drops come from C before the loop reaches W.
		await setup({ C: [11, 6], W: [14, 6], D: [4, 1], G: [4, 2] });

		await checkRosterSizes("other");

		const roster = await getRoster(0);
		assert.strictEqual(roster.length, 27); // getAiRosterTarget()

		const counts = countByPos(roster);
		// C absorbed all 6 drops (back to its POSITION_COUNTS share of 5)
		assert.strictEqual(counts.C, 5);
		// W's filler is higher value than C's, so it was never reached
		assert.strictEqual(counts.W, 14);
		// D is below its share of 7, so its min-contract player must survive
		assert.strictEqual(counts.D, 4);
		assert.strictEqual(counts.G, 4);

		// Only min-contract filler was released
		const freeAgents = await getRoster(PLAYER.FREE_AGENT);
		assert.strictEqual(freeAgents.length, 6);
		for (const p of freeAgents) {
			assert(p.value < 60, "a non-filler player was released");
		}
	});

	test("never trims healthy goalies below the key-position minimum", async () => {
		// 31 players over target+3. Goalies: 3 healthy min + 2 injured paid.
		// Position count (5 > ceil(3)) would let the loop cut to 3 G, stranding the
		// team with 1 healthy goalie - the health guard must keep 2 healthy.
		resetG();
		g.setWithoutSavingToDB("farmSystem", false);
		g.setWithoutSavingToDB("maxRosterSize", 50);
		g.setWithoutSavingToDB("minRosterSize", 20);
		g.setWithoutSavingToDB("numTeams", 2);
		g.setWithoutSavingToDB("numActiveTeams", 2);
		g.setWithoutSavingToDB("userTid", 1);
		g.setWithoutSavingToDB("userTids", [1]);

		const minContract = g.get("minContract");
		const team0 = [
			...makeRoster(0, { C: [9, 4], W: [10, 0], D: [7, 0] }), // 26, C has droppable filler
			makePlayer(0, "G", minContract, 30),
			makePlayer(0, "G", minContract, 31),
			makePlayer(0, "G", minContract, 32),
			makePlayer(0, "G", 3000, 70, true), // injured, paid (not droppable)
			makePlayer(0, "G", 3000, 71, true), // injured, paid (not droppable)
		];

		const teamsDefault = helpers.getTeamsDefault().slice(0, 2);
		await resetCache({
			players: [
				...team0,
				...makeRoster(1, { C: [5, 0], W: [10, 0], D: [7, 0], G: [3, 0] }),
			],
			teams: teamsDefault.map((t) => team.generate(t)),
		});

		await checkRosterSizes("other");

		const roster = await getRoster(0);
		const healthyGoalies = roster.filter(
			(p) => last(p.ratings).pos === "G" && p.injury.gamesRemaining === 0,
		);
		assert(
			healthyGoalies.length >= 2,
			`only ${healthyGoalies.length} healthy goalies left`,
		);
	});

	test("does nothing inside the hysteresis band above the target", async () => {
		// 30 players = target + 3, not above it
		await setup({ C: [8, 3], W: [12, 4], D: [6, 0], G: [4, 2] });

		await checkRosterSizes("other");

		assert.strictEqual((await getRoster(0)).length, 30);
		assert.strictEqual((await getRoster(PLAYER.FREE_AGENT)).length, 0);
	});

	test("never trims when paid players make up the surplus", async () => {
		// 33 players but zero min contracts: nothing is droppable
		await setup({ C: [11, 0], W: [14, 0], D: [4, 0], G: [4, 0] });

		await checkRosterSizes("other");

		assert.strictEqual((await getRoster(0)).length, 33);
	});

	test("default-size leagues are untouched", async () => {
		await setup({ C: [6, 2], W: [11, 3], D: [5, 1], G: [4, 2] }); // 26
		g.setWithoutSavingToDB("maxRosterSize", 26);
		g.setWithoutSavingToDB("minRosterSize", 24);

		await checkRosterSizes("other");

		assert.strictEqual((await getRoster(0)).length, 26);
	});
});
