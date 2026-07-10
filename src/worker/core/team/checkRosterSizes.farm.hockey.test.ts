import { assert, describe, test } from "vitest";
import { PLAYER } from "../../../common/constants.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { g, helpers } from "../../util/index.ts";
import { idb } from "../../db/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { player, team } from "../index.ts";
import checkRosterSizes from "./checkRosterSizes.ts";
import { isOnFarm } from "./farm.hockey.ts";
import { last } from "../../../common/utils.ts";

const makePlayer = (
	tid: number,
	pos: string,
	value: number,
	{
		farm = false,
		vet = false,
	}: {
		farm?: boolean;
		vet?: boolean;
	} = {},
) => {
	const p = player.generate(tid, vet ? 30 : 22, 2010, true, DEFAULT_LEVEL);
	const ratings = p.ratings[0]!;
	ratings.pos = pos;
	ratings.ovr = value;
	ratings.pot = value;
	(ratings as any).ovrs = { C: value, W: value, D: value, G: value };
	(ratings as any).pots = { C: value, W: value, D: value, G: value };
	p.value = value;
	p.contract.amount = 2000;
	p.contract.exp = g.get("season") + 2;
	if (farm) {
		p.farm = true;
	}
	if (vet) {
		p.stats = [
			{ season: g.get("season") - 1, playoffs: false, gp: 200 },
		] as any;
	}
	return p;
};

// counts like { C: [n, options] } — n players at pos
const makeGroup = (
	tid: number,
	counts: Record<string, number>,
	value = 60,
	opts: { farm?: boolean; vet?: boolean } = {},
) => {
	const players = [];
	for (const [pos, n] of Object.entries(counts)) {
		for (let i = 0; i < n; i++) {
			players.push(makePlayer(tid, pos, value, opts));
		}
	}
	return players;
};

// Team 1 is the user with a legal roster, so team 0 takes the AI path
const USER_ROSTER = { C: 4, W: 9, D: 7, G: 3 }; // 23

// buildTeam0 runs after resetG, since player.generate needs g to be set up
const setup = async (buildTeam0: () => any[]) => {
	resetG();
	g.setWithoutSavingToDB("numTeams", 2);
	g.setWithoutSavingToDB("numActiveTeams", 2);
	g.setWithoutSavingToDB("userTid", 1);
	g.setWithoutSavingToDB("userTids", [1]);

	const teamsDefault = helpers.getTeamsDefault().slice(0, 2);
	await resetCache({
		players: [...buildTeam0(), ...makeGroup(1, USER_ROSTER)],
		teams: teamsDefault.map((t) => team.generate(t)),
	});
};

const getSplit = async (tid: number) => {
	const players = await idb.cache.players.indexGetAll("playersByTid", tid);
	return {
		players,
		active: players.filter((p) => !isOnFarm(p)),
		farm: players.filter((p) => isOnFarm(p)),
	};
};

describe("checkRosterSizes with the farm system", () => {
	test("active surplus is sent down, not released (the draft-pick retention fix)", async () => {
		// 26 actives, all waiver-exempt. Old behavior would release 3; farm behavior sends them down.
		await setup(() => [
			...makeGroup(0, { C: 4, W: 10, D: 7 }),
			...makeGroup(0, { G: 1 }, 30),
			...makeGroup(0, { G: 1 }, 31),
			...makeGroup(0, { W: 1 }, 32),
			...makeGroup(0, { G: 2 }),
		]);

		await checkRosterSizes("other");

		const { players, active, farm } = await getSplit(0);
		assert.strictEqual(players.length, 26, "org size changed");
		assert.isAtMost(active.length, g.get("maxRosterSize"));
		assert.isAbove(farm.length, 0);

		// Nobody was released
		const freeAgents = await idb.cache.players.indexGetAll(
			"playersByTid",
			PLAYER.FREE_AGENT,
		);
		assert.strictEqual(freeAgents.length, 0);

		// The lowest-value players are the ones in the minors
		for (const p of farm) {
			assert.isBelow(p.value, 60);
		}
	});

	test("active shortfall is filled from the farm before free agency", async () => {
		// 18 actives + 4 farm players covering the holes, empty FA pool
		await setup(() => [
			...makeGroup(0, { C: 4, W: 8, D: 5, G: 1 }),
			...makeGroup(0, { W: 2, D: 1, G: 1 }, 50, { farm: true }),
		]);

		const numPlayersBefore = (
			await idb.cache.players.indexGetAll("playersByTid", [
				PLAYER.FREE_AGENT,
				Infinity,
			])
		).length;

		await checkRosterSizes("other");

		const { players, active } = await getSplit(0);
		assert.isAtLeast(active.length, g.get("minRosterSize"));
		assert.strictEqual(players.length, 22, "org size changed");

		// No free agents were generated or signed
		const numPlayersAfter = (
			await idb.cache.players.indexGetAll("playersByTid", [
				PLAYER.FREE_AGENT,
				Infinity,
			])
		).length;
		assert.strictEqual(numPlayersAfter, numPlayersBefore);

		// The healthy goalie need was filled
		const activeG = active.filter((p) => last(p.ratings).pos === "G");
		assert.isAtLeast(activeG.length, 2);
	});

	test("veteran surplus still gets released when nobody is waiver-exempt", async () => {
		await setup(() => [
			...makeGroup(0, { C: 5, W: 9, D: 6, G: 3 }, 60, { vet: true }),
			...makeGroup(0, { C: 1 }, 30, { vet: true }),
			...makeGroup(0, { W: 1 }, 31, { vet: true }),
			...makeGroup(0, { W: 1 }, 32, { vet: true }),
		]); // 26 actives, none exempt

		await checkRosterSizes("other");

		const { players, active, farm } = await getSplit(0);
		assert.strictEqual(farm.length, 0);
		assert.isAtMost(active.length, g.get("maxRosterSize"));
		assert.strictEqual(players.length, 23);

		const freeAgents = await idb.cache.players.indexGetAll(
			"playersByTid",
			PLAYER.FREE_AGENT,
		);
		assert.strictEqual(freeAgents.length, 3);
		for (const p of freeAgents) {
			assert.isBelow(p.value, 60, "a non-filler player was released");
		}
	});

	test("organizations over maxContracts release worst players, farm first", async () => {
		await setup(() => [
			...makeGroup(0, { C: 4, W: 9, D: 7, G: 3 }), // 23 actives
			...makeGroup(0, { W: 3 }, 50, { farm: true }),
			...makeGroup(0, { W: 1 }, 30, { farm: true }),
			...makeGroup(0, { D: 1 }, 31, { farm: true }),
			...makeGroup(0, { G: 1 }, 32, { farm: true }),
		]); // 29 contracts
		g.setWithoutSavingToDB("maxContracts", 26);

		await checkRosterSizes("other");

		const { players, active } = await getSplit(0);
		assert.strictEqual(players.length, 26);
		assert.strictEqual(active.length, 23, "actives were released");

		const freeAgents = await idb.cache.players.indexGetAll(
			"playersByTid",
			PLAYER.FREE_AGENT,
		);
		assert.strictEqual(freeAgents.length, 3);
		// dropPlayers' position guards protect the lone farm D and G, so the
		// drops all come from the winger surplus, lowest value first
		for (const p of freeAgents) {
			assert.strictEqual(last(p.ratings).pos, "W");
		}
		const { farm } = await getSplit(0);
		const farmValues = farm.map((p) => p.value).sort();
		assert.deepStrictEqual(farmValues, [31, 32, 50]);
	});

	test("user team gets error strings instead of auto moves", async () => {
		// User (team 1) over the active max
		resetG();
		g.setWithoutSavingToDB("numTeams", 2);
		g.setWithoutSavingToDB("numActiveTeams", 2);
		g.setWithoutSavingToDB("userTid", 1);
		g.setWithoutSavingToDB("userTids", [1]);

		const teamsDefault = helpers.getTeamsDefault().slice(0, 2);
		await resetCache({
			players: [
				...makeGroup(0, USER_ROSTER),
				...makeGroup(1, { C: 5, W: 10, D: 7, G: 3 }), // 25 actives
			],
			teams: teamsDefault.map((t) => team.generate(t)),
		});

		const error = await checkRosterSizes("user");
		assert.isString(error);
		assert.include(error!, "active roster");

		// Nothing moved automatically
		const { players, farm } = await getSplit(1);
		assert.strictEqual(players.length, 25);
		assert.strictEqual(farm.length, 0);
	});
});
