import { assert, test } from "vitest";
import { PLAYER } from "../../../common/constants.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { g, helpers } from "../../util/index.ts";
import { idb } from "../../db/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { player, team } from "../index.ts";
import checkRosterSizes from "./checkRosterSizes.ts";
import loadTeams from "../game/loadTeams.ts";
import { isOnFarm } from "./farm.hockey.ts";
import { last } from "../../../common/utils.ts";

// Deterministic RNG, same generator as franchise10yr.hockey.test.ts
const mulberry32 = (seed: number) => {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const makePlayer = (tid: number, pos: string, value: number, farm = false) => {
	const p = player.generate(tid, 22, 2010, true, DEFAULT_LEVEL);
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
	return p;
};

const makeOrg = (tid: number, rand: () => number) => {
	const players = [];

	// 23 actives: 13 F (4 C + 9 W), 7 D, 3 G with spread values
	const activeSpec: [string, number][] = [
		...Array.from({ length: 4 }, () => ["C", 45 + Math.floor(rand() * 25)]),
		...Array.from({ length: 9 }, () => ["W", 45 + Math.floor(rand() * 25)]),
		...Array.from({ length: 7 }, () => ["D", 45 + Math.floor(rand() * 25)]),
		...Array.from({ length: 3 }, () => ["G", 45 + Math.floor(rand() * 25)]),
	] as [string, number][];
	for (const [pos, value] of activeSpec) {
		players.push(makePlayer(tid, pos, value));
	}

	// 8 farm prospects, including a blue-chipper who deserves a promotion
	const farmSpec: [string, number][] = [
		["C", 75], // the blue-chip prospect
		["W", 30 + Math.floor(rand() * 20)],
		["W", 30 + Math.floor(rand() * 20)],
		["C", 30 + Math.floor(rand() * 20)],
		["D", 30 + Math.floor(rand() * 20)],
		["D", 30 + Math.floor(rand() * 20)],
		["G", 40],
		["W", 30 + Math.floor(rand() * 20)],
	];
	for (const [pos, value] of farmSpec) {
		players.push(makePlayer(tid, pos, value, true));
	}

	return players;
};

test("AI farm management holds its invariants across a month of simulated days", async () => {
	const originalRandom = Math.random;
	const rand = mulberry32(20260710);
	Math.random = rand;

	try {
		resetG();
		const numTeams = 2;
		g.setWithoutSavingToDB("numTeams", numTeams);
		g.setWithoutSavingToDB("numActiveTeams", numTeams);
		// No user team among the two, so both take the AI path
		g.setWithoutSavingToDB("userTid", 99);
		g.setWithoutSavingToDB("userTids", [99]);

		const teamsDefault = helpers.getTeamsDefault().slice(0, numTeams);
		const teams = teamsDefault.map((t) => team.generate(t));
		await resetCache({
			players: [...makeOrg(0, rand), ...makeOrg(1, rand)],
			teams,
			teamSeasons: teams.map((t: any) => team.genSeasonRow(t)),
			teamStats: teams.map((t: any) => team.genStatsRow(t.tid)),
		});

		const tids = [0, 1];

		for (let day = 0; day < 30; day++) {
			// Random injuries to active players, like a game day would produce
			for (const tid of tids) {
				const players = await idb.cache.players.indexGetAll(
					"playersByTid",
					tid,
				);
				const actives = players.filter(
					(p) => !isOnFarm(p) && p.injury.gamesRemaining === 0,
				);
				if (rand() < 0.5 && actives.length > 0) {
					const victim = actives[Math.floor(rand() * actives.length)]!;
					victim.injury = {
						type: "Sprained ankle",
						gamesRemaining: 2 + Math.floor(rand() * 6),
					};
					await idb.cache.players.put(victim);
				}
			}

			await checkRosterSizes("other");

			// Invariants, checked every day for every team
			for (const tid of tids) {
				const players = await idb.cache.players.indexGetAll(
					"playersByTid",
					tid,
				);
				const actives = players.filter((p) => !isOnFarm(p));

				assert.isAtMost(
					actives.length,
					g.get("maxRosterSize"),
					`day ${day}: team ${tid} over the active max`,
				);
				assert.isAtLeast(
					actives.length,
					g.get("minRosterSize"),
					`day ${day}: team ${tid} under the active min`,
				);
			}

			// Nobody ever gets released: every prospect stays in the organization
			const freeAgents = await idb.cache.players.indexGetAll(
				"playersByTid",
				PLAYER.FREE_AGENT,
			);
			const releasedPlayers = freeAgents.filter((p) => p.value > 25);
			assert.strictEqual(
				releasedPlayers.length,
				0,
				`day ${day}: a prospect was released`,
			);

			// The game sim never sees farm players
			const loaded = await loadTeams(tids, {} as any);
			for (const tid of tids) {
				const loadedTeam = (loaded as any)[tid];
				for (const p of loadedTeam.player) {
					const cached = await idb.cache.players.get(p.id);
					assert.isNotOk(
						cached && isOnFarm(cached),
						`day ${day}: farm player ${p.id} dressed for team ${tid}`,
					);
				}
			}

			// Heal one day
			for (const tid of tids) {
				const players = await idb.cache.players.indexGetAll(
					"playersByTid",
					tid,
				);
				for (const p of players) {
					if (p.injury.gamesRemaining > 0) {
						p.injury.gamesRemaining -= 1;
						if (p.injury.gamesRemaining === 0) {
							p.injury = { type: "Healthy", gamesRemaining: 0 };
						}
						await idb.cache.players.put(p);
					}
				}
			}
		}

		// The blue-chip prospects (value 75) must have been promoted along the way
		for (const tid of tids) {
			const players = await idb.cache.players.indexGetAll("playersByTid", tid);
			const blueChip = players.find((p) => p.value === 75);
			assert.isOk(blueChip, `team ${tid} lost its blue-chip prospect`);
			assert.isNotOk(
				isOnFarm(blueChip!),
				`team ${tid}'s blue-chip prospect is still in the minors`,
			);
			assert.strictEqual(last(blueChip!.ratings).pos, "C");
		}
	} finally {
		Math.random = originalRandom;
	}
}, 120000);
