import { assert, beforeEach, describe, test } from "vitest";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { g, helpers } from "../../util/index.ts";
import { idb } from "../../db/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { player, team } from "../index.ts";
import { manageFarmAll, manageFarmTeam } from "./manageFarm.hockey.ts";
import { isOnFarm } from "./farm.hockey.ts";
import { FARM_PROMOTE_MARGIN } from "../../../common/constants.hockey.ts";
import { last } from "../../../common/utils.ts";

const makePlayer = (
	tid: number,
	pos: string,
	value: number,
	{
		farm = false,
		injured = false,
		vet = false,
	}: { farm?: boolean; injured?: boolean; vet?: boolean } = {},
) => {
	const p = player.generate(tid, vet ? 30 : 23, 2010, true, DEFAULT_LEVEL);
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
	if (injured) {
		p.injury = { type: "Sprained ankle", gamesRemaining: 10 };
	}
	if (vet) {
		// Old enough and experienced enough to not be waiver-exempt
		p.stats = [
			{ season: g.get("season") - 1, playoffs: false, gp: 200 },
		] as any;
	}
	return p;
};

// A legal 22-man active roster: 13 F (4 C + 9 W), 7 D, 2 G — exactly the AI's FARM_ACTIVE_TARGETS
const makeActives = (tid: number, value = 60) => [
	...Array.from({ length: 4 }, () => makePlayer(tid, "C", value)),
	...Array.from({ length: 9 }, () => makePlayer(tid, "W", value)),
	...Array.from({ length: 7 }, () => makePlayer(tid, "D", value)),
	...Array.from({ length: 2 }, () => makePlayer(tid, "G", value)),
];

const getRoster = async (tid: number) =>
	idb.cache.players.indexGetAll("playersByTid", tid);

const split = async (tid: number) => {
	const players = await getRoster(tid);
	return {
		active: players.filter((p) => !isOnFarm(p)),
		farm: players.filter((p) => isOnFarm(p)),
	};
};

beforeEach(() => {
	resetG();
});

describe("manageFarmTeam", () => {
	test("injured goalie triggers a call-up, swapping out a surplus forward when the roster is full", async () => {
		const players = [
			...makeActives(0),
			makePlayer(0, "W", 45), // 23rd man, surplus F
			makePlayer(0, "G", 50, { farm: true }),
			makePlayer(0, "W", 40, { farm: true }),
		];
		// Injure one active goalie
		const activeG = players.find(
			(p) => last(p.ratings).pos === "G" && !p.farm,
		)!;
		activeG.injury = { type: "Sprained ankle", gamesRemaining: 10 };

		await resetCache({ players });

		const moved = await manageFarmTeam(0);
		assert.isAbove(moved.length, 0);

		const { active, farm } = await split(0);
		assert.strictEqual(active.length, 23);

		const healthyActiveG = active.filter(
			(p) => last(p.ratings).pos === "G" && p.injury.gamesRemaining === 0,
		);
		assert.strictEqual(healthyActiveG.length, 2);

		// The worst surplus forward was the one sent down
		const farmValues = farm.map((p) => p.value);
		assert.include(farmValues, 45);
	});

	test("quality promotion requires the margin", async () => {
		const worstActiveValue = 60;

		// Below the margin: no move
		await resetCache({
			players: [
				...makeActives(0, worstActiveValue),
				makePlayer(0, "W", worstActiveValue + FARM_PROMOTE_MARGIN - 1, {
					farm: true,
				}),
			],
		});
		assert.strictEqual((await manageFarmTeam(0)).length, 0);

		// At the margin: promoted
		await resetCache({
			players: [
				...makeActives(0, worstActiveValue),
				makePlayer(0, "W", worstActiveValue + FARM_PROMOTE_MARGIN, {
					farm: true,
				}),
			],
		});
		assert.isAbove((await manageFarmTeam(0)).length, 0);

		const { active, farm } = await split(0);
		assert.strictEqual(farm.length, 0);
		assert.include(
			active.map((p) => p.value),
			worstActiveValue + FARM_PROMOTE_MARGIN,
		);
	});

	test("no oscillation: repeated runs settle after the first", async () => {
		const players = [
			...makeActives(0),
			makePlayer(0, "W", 45), // 23rd man
			makePlayer(0, "W", 70, { farm: true }), // clearly better prospect
			makePlayer(0, "G", 50, { farm: true }),
		];
		await resetCache({ players });

		const firstMoves = await manageFarmTeam(0);
		assert.isAbove(firstMoves.length, 0);

		for (let i = 0; i < 3; i++) {
			const moves = await manageFarmTeam(0);
			assert.strictEqual(moves.length, 0, `moves happened on settle run ${i}`);
		}
	});

	test("veterans are never sent down, even with a surplus", async () => {
		const players = [
			...makeActives(0).map((p) => {
				p.born.year = g.get("season") - 30;
				p.stats = [
					{ season: g.get("season") - 1, playoffs: false, gp: 200 },
				] as any;
				return p;
			}),
			makePlayer(0, "W", 40, { vet: true }),
			makePlayer(0, "W", 41, { vet: true }),
		]; // 24 actives, all non-exempt
		await resetCache({ players });

		const moved = await manageFarmTeam(0);
		assert.strictEqual(moved.length, 0);

		const { active } = await split(0);
		assert.strictEqual(active.length, 24);
	});

	test("does nothing when the farm system is disabled", async () => {
		g.setWithoutSavingToDB("farmSystem", false);
		await resetCache({
			players: [...makeActives(0), makePlayer(0, "W", 45)],
		});
		assert.strictEqual((await manageFarmTeam(0)).length, 0);
	});
});

describe("manageFarmAll", () => {
	test("manages AI teams but never the user's team", async () => {
		g.setWithoutSavingToDB("userTid", 0);
		g.setWithoutSavingToDB("userTids", [0]);

		const teamsDefault = helpers.getTeamsDefault().slice(0, 2);
		await resetCache({
			players: [
				// Both teams have a prospect who clearly deserves a promotion
				...makeActives(0),
				makePlayer(0, "W", 80, { farm: true }),
				...makeActives(1),
				makePlayer(1, "W", 80, { farm: true }),
			],
			teams: teamsDefault.map((t) => team.generate(t)),
		});

		await manageFarmAll();

		const user = await split(0);
		assert.strictEqual(user.farm.length, 1, "user team was touched");

		const ai = await split(1);
		assert.strictEqual(ai.farm.length, 0, "AI team was not managed");
	});
});
