import { assert, beforeAll, test } from "vitest";
import GameSim from "../GameSim.hockey/index.ts";
import { player, team } from "../index.ts";
import loadTeams from "./loadTeams.ts";
import writePlayerStats, {
	getHockeyGoalieDecisionPid,
} from "./writePlayerStats.ts";
import { idb } from "../../db/index.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";

const genTwoTeams = async () => {
	resetG();
	g.setWithoutSavingToDB("season", 2013);
	g.setWithoutSavingToDB("homeCourtAdvantage", 0);

	const teamsDefault = helpers.getTeamsDefault().slice(0, 2);

	const players = [];
	for (const tid of [0, 1]) {
		for (let i = 0; i < 30; i++) {
			const p = player.generate(tid, 25, 2010, true, DEFAULT_LEVEL);

			// Without develop, ovrs are all 0 and the sim degenerates (NaN save percentage)
			await player.develop(p, 6, false, DEFAULT_LEVEL);
			players.push(p);
		}
	}

	await resetCache({
		players,
		teams: teamsDefault.map(team.generate),
		teamSeasons: teamsDefault.map((t) => team.genSeasonRow(t)),
		teamStats: teamsDefault.map((t) => team.genStatsRow(t.tid)),
	});

	// Hockey GameSim needs a real depth chart
	await team.rosterAutoSort(0);
	await team.rosterAutoSort(1);
};

const loadGameTeams = async () => {
	const teams = await loadTeams([0, 1], {});
	for (const t of [teams[0], teams[1]]) {
		if (t.depth !== undefined) {
			t.depth = team.getDepthPlayers(t.depth, t.player);
		}
	}
	return [teams[0], teams[1]] as [any, any];
};

const runGame = async (gid: number): Promise<any> =>
	new GameSim({
		gid,
		teams: await loadGameTeams(),
		baseInjuryRate: 0,
		doPlayByPlay: false,
		homeCourtFactor: 1,
		allStarGame: false,
		neutralSite: false,
	}).run();

beforeAll(async () => {
	await genTwoTeams();
});

test("getHockeyGoalieDecisionPid follows the NHL decision rule", () => {
	// Team 0 wins 4-2. Its starter (10) was shelled and hooked for the relief
	// goalie (11), who was in net for the decisive goal. The loser's starter
	// (20) allowed that goal before being hooked for his own backup (21).
	const result = {
		team: [{ stat: { pts: 4 } }, { stat: { pts: 2 } }],
		goaliesAtGoals: [
			{ t: 1, goaliePids: [10, 20] }, // 0-1
			{ t: 1, goaliePids: [10, 20] }, // 0-2
			{ t: 0, goaliePids: [11, 20] }, // 1-2
			{ t: 0, goaliePids: [11, 20] }, // 2-2
			{ t: 0, goaliePids: [11, 20] }, // 3-2, the goal that wins the game
			{ t: 0, goaliePids: [11, 21] }, // 4-2
		],
	};

	// W to the relief goalie, L to the starter who allowed the decisive goal
	assert.strictEqual(getHockeyGoalieDecisionPid(result, 0, 0), 11);
	assert.strictEqual(getHockeyGoalieDecisionPid(result, 1, 0), 20);

	// Empty net at the decisive goal -> undefined, caller falls back to most saves
	const emptyNet = {
		...result,
		goaliesAtGoals: result.goaliesAtGoals.map((goal) => ({
			...goal,
			goaliePids: [goal.goaliePids[0], undefined],
		})),
	};
	assert.isUndefined(getHockeyGoalieDecisionPid(emptyNet, 1, 0));

	// Missing data (old replays) -> undefined for both teams
	assert.isUndefined(getHockeyGoalieDecisionPid({ team: result.team }, 0, 0));

	// Shootout (pts tied): the decision goes to whoever was in net for the shootout
	const shootout = {
		team: [{ stat: { pts: 2, sPts: 2 } }, { stat: { pts: 2, sPts: 1 } }],
		goaliesAtGoals: result.goaliesAtGoals.slice(0, 4),
		shootoutGoaliePids: [11, 21],
	};
	assert.strictEqual(getHockeyGoalieDecisionPid(shootout, 0, 0), 11);
	assert.strictEqual(getHockeyGoalieDecisionPid(shootout, 1, 0), 21);
});

test(
	"end to end: the W goes to the relief goalie and the L to the hooked starter who allowed the decisive goal",
	{ timeout: 120000 },
	async () => {
		const result = await runGame(0);

		// GameSim records the goalies in net for every goal, and they are real players from the right team
		assert.strictEqual(
			result.goaliesAtGoals.length,
			result.team[0].stat.pts + result.team[1].stat.pts,
		);
		for (const goal of result.goaliesAtGoals) {
			for (const t of [0, 1] as const) {
				const pid = goal.goaliePids[t];
				if (pid !== undefined) {
					assert.isDefined(
						result.team[t].player.find((p: any) => p.id === pid),
					);
				}
			}
		}

		// Rig a 4-2 win for team 0. The winner's starter was shelled (most saves)
		// before the hook; the relief goalie was in net for the decisive goal. The
		// loser's starter allowed it before being hooked for a backup who then
		// out-saved him.
		const playersWhoPlayed = (i: 0 | 1) =>
			result.team[i].player.filter((p: any) => p.stat.gp > 0 && p.stat.min > 0);
		const [starter0, relief0] = playersWhoPlayed(0);
		const [starter1, relief1] = playersWhoPlayed(1);

		result.team[0].stat.pts = 4;
		result.team[1].stat.pts = 2;
		result.overtimes = 0;
		result.majorPenalties = [];

		for (const i of [0, 1] as const) {
			for (const p of result.team[i].player) {
				p.stat.sv = 0;
			}
		}
		starter0.stat.sv = 30;
		relief0.stat.sv = 5;
		starter1.stat.sv = 3;
		relief1.stat.sv = 25;

		result.goaliesAtGoals = [
			{ t: 1, goaliePids: [starter0.id, starter1.id] }, // 0-1
			{ t: 1, goaliePids: [starter0.id, starter1.id] }, // 0-2
			{ t: 0, goaliePids: [relief0.id, starter1.id] }, // 1-2
			{ t: 0, goaliePids: [relief0.id, starter1.id] }, // 2-2
			{ t: 0, goaliePids: [relief0.id, starter1.id] }, // 3-2, decisive
			{ t: 0, goaliePids: [relief0.id, relief1.id] }, // 4-2
		];

		await writePlayerStats([result], {});

		const ps = async (pid: number) =>
			(await idb.cache.players.get(pid))!.stats.at(-1)!;

		// Old behavior (most saves) would have given the W to starter0 and the L to relief1
		assert.strictEqual((await ps(relief0.id)).gW, 1);
		assert.strictEqual((await ps(starter0.id)).gW ?? 0, 0);
		assert.strictEqual((await ps(starter1.id)).gL, 1);
		assert.strictEqual((await ps(relief1.id)).gL ?? 0, 0);
	},
);

test(
	"end to end: a shootout decision goes to the goalies in net for the shootout",
	{ timeout: 120000 },
	async () => {
		const result = await runGame(1);

		const playersWhoPlayed = (i: 0 | 1) =>
			result.team[i].player.filter((p: any) => p.stat.gp > 0 && p.stat.min > 0);
		// Decoys with the most saves, to prove the shootout goalies override them. slice(2) avoids the players the previous test already credited with decisions
		const [decoy0, shootoutG0] = playersWhoPlayed(0).slice(2);
		const [decoy1, shootoutG1] = playersWhoPlayed(1).slice(2);

		result.team[0].stat.pts = 2;
		result.team[1].stat.pts = 2;
		result.team[0].stat.sPts = 2;
		result.team[1].stat.sPts = 1;
		result.overtimes = 1;
		result.majorPenalties = [];
		result.shootoutGoaliePids = [shootoutG0.id, shootoutG1.id];

		for (const i of [0, 1] as const) {
			for (const p of result.team[i].player) {
				p.stat.sv = 0;
			}
		}
		decoy0.stat.sv = 20;
		decoy1.stat.sv = 20;

		await writePlayerStats([result], {});

		const ps = async (pid: number) =>
			(await idb.cache.players.get(pid))!.stats.at(-1)!;

		const loserKey = g.get("otl", "current") ? "gOTL" : "gL";
		assert.strictEqual((await ps(shootoutG0.id)).gW, 1);
		assert.strictEqual((await ps(shootoutG1.id))[loserKey], 1);
		assert.strictEqual((await ps(decoy0.id)).gW ?? 0, 0);
		assert.strictEqual((await ps(decoy1.id))[loserKey] ?? 0, 0);
	},
);
