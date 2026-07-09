import { assert, beforeAll, test } from "vitest";
import GameSim from "./index.ts";
import { player, team } from "../index.ts";
import loadTeams from "../game/loadTeams.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { PHASE } from "../../../common/constants.ts";
import { penalties } from "./penalties.ts";
import type { TeamNum } from "../../../common/types.ts";
import { orderBy } from "../../../common/utils.ts";

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

const makeGameSim = (teams: [any, any], gid = 0) =>
	new GameSim({
		gid,
		teams,
		baseInjuryRate: 0,
		doPlayByPlay: false,
		homeCourtFactor: 1,
		allStarGame: false,
		neutralSite: false,
	});

type Snapshot = {
	skaters: [number, number];
	goalies: [number, number];
	penaltyBox: [number, number];
};

const countSkaters = (game: GameSim, t: TeamNum) =>
	game.playersOnIce[t].C.length +
	game.playersOnIce[t].W.length +
	game.playersOnIce[t].D.length;

// Record who is on the ice every time the clock moves
const instrumentOnIce = (game: GameSim) => {
	const snapshots: Snapshot[] = [];
	const origAdvanceClock = game.advanceClock.bind(game);
	(game as any).advanceClock = (special?: "rebound") => {
		snapshots.push({
			skaters: [countSkaters(game, 0), countSkaters(game, 1)],
			goalies: [game.playersOnIce[0].G.length, game.playersOnIce[1].G.length],
			penaltyBox: [game.penaltyBox.count(0), game.penaltyBox.count(1)],
		});
		return origAdvanceClock(special);
	};
	return snapshots;
};

beforeAll(async () => {
	await genTwoTeams();
});

test("regular season overtime is 3-on-3 while the penalty box is empty", async () => {
	g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
	g.setWithoutSavingToDB("foulRateFactor", 0); // Keep the penalty box empty

	for (let i = 0; i < 10; i++) {
		const game = makeGameSim(await loadGameTeams(), i);
		const snapshots = instrumentOnIce(game);
		game.simOvertime();

		assert.isTrue(game.threeOnThree);
		assert.isAbove(snapshots.length, 0);
		for (const snapshot of snapshots) {
			assert.deepStrictEqual(snapshot.skaters, [3, 3]);
			assert.deepStrictEqual(snapshot.goalies, [1, 1]);
		}
	}
});

test("playoff overtime stays 5-on-5", async () => {
	g.setWithoutSavingToDB("phase", PHASE.PLAYOFFS);
	g.setWithoutSavingToDB("foulRateFactor", 0);

	const game = makeGameSim(await loadGameTeams());
	const snapshots = instrumentOnIce(game);
	game.simOvertime();

	assert.isFalse(game.threeOnThree);
	assert.isAbove(snapshots.length, 0);
	for (const snapshot of snapshots) {
		assert.deepStrictEqual(snapshot.skaters, [5, 5]);
		assert.deepStrictEqual(snapshot.goalies, [1, 1]);
	}
});

test("a penalty during 3-on-3 gives the power play team an extra skater", async () => {
	g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
	g.setWithoutSavingToDB("foulRateFactor", 1);

	const game = makeGameSim(await loadGameTeams());
	game.threeOnThree = true;
	game.clock = 5;
	game.updatePlayersOnIce({ type: "newPeriod" });

	assert.strictEqual(countSkaters(game, 0), 3);
	assert.strictEqual(countSkaters(game, 1), 3);

	const minor = penalties.find((penalty) => penalty.type === "minor")!;

	// First penalty: 4-on-3, the shorthanded team keeps 3 skaters
	const p1 = game.playersOnIce[0].D[0]!;
	game.penaltyBox.add(0, p1, minor);
	game.updatePlayersOnIce({ type: "penalty" });

	assert.notInclude(Object.values(game.playersOnIce[0]).flat(), p1);
	assert.strictEqual(countSkaters(game, 0), 3);
	assert.strictEqual(countSkaters(game, 1), 4);
	assert.strictEqual(game.playersOnIce[0].G.length, 1);
	assert.strictEqual(game.playersOnIce[1].G.length, 1);

	// Second penalty on the same team: 5-on-3
	const p2 = game.playersOnIce[0].C[0]!;
	game.penaltyBox.add(0, p2, minor);
	game.updatePlayersOnIce({ type: "penalty" });

	assert.strictEqual(countSkaters(game, 0), 3);
	assert.strictEqual(countSkaters(game, 1), 5);
});

test("offsetting penalties during 3-on-3 add a skater to each side", async () => {
	g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
	g.setWithoutSavingToDB("foulRateFactor", 1);

	const game = makeGameSim(await loadGameTeams());
	game.threeOnThree = true;
	game.clock = 5;
	game.updatePlayersOnIce({ type: "newPeriod" });

	const minor = penalties.find((penalty) => penalty.type === "minor")!;

	// Box counts 1-1: each side adds a skater rather than losing one, so 4-on-4 (NHL rule 84.3)
	const p0 = game.playersOnIce[0].D[0]!;
	const p1 = game.playersOnIce[1].D[0]!;
	game.penaltyBox.add(0, p0, minor);
	game.penaltyBox.add(1, p1, minor);
	game.updatePlayersOnIce({ type: "penalty" });

	assert.strictEqual(countSkaters(game, 0), 4);
	assert.strictEqual(countSkaters(game, 1), 4);
	assert.notInclude(Object.values(game.playersOnIce[0]).flat(), p0);
	assert.notInclude(Object.values(game.playersOnIce[1]).flat(), p1);

	// Box counts 2-1: 5-on-4
	const p2 = game.playersOnIce[0].C[0]!;
	game.penaltyBox.add(0, p2, minor);
	game.updatePlayersOnIce({ type: "penalty" });

	assert.strictEqual(countSkaters(game, 0), 4);
	assert.strictEqual(countSkaters(game, 1), 5);
});

test("injured forwards do not take shootout attempts", async () => {
	g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
	g.setWithoutSavingToDB("foulRateFactor", 0);
	g.setWithoutSavingToDB("shootoutRounds", 3);

	const game = makeGameSim(await loadGameTeams());

	// The best shooter would normally lead off the shootout
	const best = orderBy(
		game.team[0].depth.F,
		(p) => p.compositeRating.scoring,
		"desc",
	)[0]!;
	best.injured = true;

	const shooters: unknown[] = [];
	const origDoShootoutShot = game.doShootoutShot.bind(game);
	(game as any).doShootoutShot = (t: TeamNum, p: any, goalie: any) => {
		if (t === 0) {
			shooters.push(p);
		}
		return origDoShootoutShot(t, p, goalie);
	};

	game.doShootout();

	assert.isAbove(shooters.length, 0);
	assert.notInclude(shooters, best);
});

test("3-on-3 overtime with many penalties never throws and never goes below 3 skaters", async () => {
	g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
	g.setWithoutSavingToDB("foulRateFactor", 5);

	let sawPenalty = false;
	for (let i = 0; i < 25; i++) {
		const game = makeGameSim(await loadGameTeams(), i);
		const snapshots = instrumentOnIce(game);
		game.simOvertime();

		for (const snapshot of snapshots) {
			for (const t of [0, 1] as const) {
				// 3 at 3-on-3, up to 5 on a 5-on-3 power play or in the 4-on-4 window after a penalty expires
				assert.isAtLeast(snapshot.skaters[t], 3);
				assert.isAtMost(snapshot.skaters[t], 5);
				assert.strictEqual(snapshot.goalies[t], 1);
			}
			if (snapshot.penaltyBox[0] > 0 || snapshot.penaltyBox[1] > 0) {
				sawPenalty = true;
			}
		}
	}

	assert.isTrue(sawPenalty);
});

test("an NHL-like fraction of regular season overtimes ends before the shootout", async () => {
	g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
	g.setWithoutSavingToDB("foulRateFactor", 1);

	const numGames = 200;
	let endedInOvertime = 0;
	for (let i = 0; i < numGames; i++) {
		const game = makeGameSim(await loadGameTeams(), i);
		game.simOvertime();
		if (game.team[0].stat.pts !== game.team[1].stat.pts) {
			endedInOvertime += 1;
		}
	}

	const fraction = endedInOvertime / numGames;
	console.log(`fraction of overtimes decided before the shootout: ${fraction}`);

	// Real NHL is ~65-75%; generous band to avoid flakiness
	assert.isAtLeast(fraction, 0.5);
	assert.isAtMost(fraction, 0.9);
});
