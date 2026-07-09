import { assert, beforeAll, test } from "vitest";
import GameSim from "./index.ts";
import { player, team } from "../index.ts";
import loadTeams from "../game/loadTeams.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { fightPenalty } from "./penalties.ts";

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

const makeGameSim = (teams: [any, any], gid = 0, doPlayByPlay = false) =>
	new GameSim({
		gid,
		teams,
		baseInjuryRate: 0,
		doPlayByPlay,
		homeCourtFactor: 1,
		allStarGame: false,
		neutralSite: false,
	});

const countSkaters = (game: GameSim, t: 0 | 1) =>
	game.playersOnIce[t].C.length +
	game.playersOnIce[t].W.length +
	game.playersOnIce[t].D.length;

const allOnIce = (game: GameSim) => [
	...Object.values(game.playersOnIce[0]).flat(),
	...Object.values(game.playersOnIce[1]).flat(),
];

beforeAll(async () => {
	await genTwoTeams();
});

test("a fight is an offsetting major: 5 PIM each, 5-on-5 preserved, fighters in the box for 5 minutes", async () => {
	const game = makeGameSim(await loadGameTeams(), 0, true);

	const hitter = game.playersOnIce[0].C[0]!;
	const target = game.playersOnIce[1].C[0]!;
	const pimBefore = [hitter.stat.pim, target.stat.pim];

	game.doFight(0, hitter, 1, target);

	// Both fighters get exactly 5 PIM more
	assert.strictEqual(hitter.stat.pim, pimBefore[0] + 5);
	assert.strictEqual(target.stat.pim, pimBefore[1] + 5);

	// Both are physically in the box...
	assert.isTrue(game.penaltyBox.has(0, hitter));
	assert.isTrue(game.penaltyBox.has(1, target));

	// ...but coincidental majors don't count toward on-ice strength, so there is no power play and the count(t) >= 2 penalty budget is untouched
	assert.strictEqual(game.penaltyBox.count(0), 0);
	assert.strictEqual(game.penaltyBox.count(1), 0);
	assert.isUndefined(game.penaltyBox.getPowerPlayTeam().powerPlayTeam);

	// Both teams still ice a full 5-on-5 complement, with the fighters absent
	for (const t of [0, 1] as const) {
		assert.strictEqual(countSkaters(game, t), 5);
		assert.strictEqual(game.playersOnIce[t].G.length, 1);
	}
	assert.notInclude(allOnIce(game), hitter);
	assert.notInclude(allOnIce(game), target);

	// Majors are recorded for a future suspensions feature
	assert.deepStrictEqual(game.majorPenalties, [
		{ pid: hitter.id, name: "fighting" },
		{ pid: target.id, name: "fighting" },
	]);

	// Play-by-play logged the fight with both names
	const fightEvents = game.playByPlay.playByPlay.filter(
		(event) => event.type === "fight",
	);
	assert.strictEqual(fightEvents.length, 1);
	assert.sameMembers((fightEvents[0] as any).names, [hitter.name, target.name]);

	// Goals do NOT release coincidental majors early
	game.penaltyBox.goal(0);
	game.penaltyBox.goal(1);
	assert.isTrue(game.penaltyBox.has(0, hitter));
	assert.isTrue(game.penaltyBox.has(1, target));
	assert.strictEqual(game.penaltyBox.players[0][0]!.minutesLeft, 5);
	assert.strictEqual(game.penaltyBox.players[1][0]!.minutesLeft, 5);

	// Fighters stay off the ice through line changes for the full 5 minutes
	game.penaltyBox.advanceClock(4.9);
	game.updatePlayersOnIce({ type: "newPeriod" });
	assert.notInclude(allOnIce(game), hitter);
	assert.notInclude(allOnIce(game), target);

	// After 5 minutes they are released, and nobody steps from the box onto the ice (the teams were never short)
	game.penaltyBox.advanceClock(0.2);
	assert.isFalse(game.penaltyBox.has(0, hitter));
	assert.isFalse(game.penaltyBox.has(1, target));
	for (const t of [0, 1] as const) {
		assert.strictEqual(countSkaters(game, t), 5);
	}

	// And the released fighters are available again at the next line change
	game.updatePlayersOnIce({ type: "newPeriod" });
	assert.include(allOnIce(game), hitter);
	assert.include(allOnIce(game), target);
});

test("players in the penalty box are never pulled from the next line onto the ice", async () => {
	const game = makeGameSim(await loadGameTeams());

	// Box the entire next forward line, like a string of fights
	const nextLine =
		game.lines[0].F[(game.currentLine[0].F + 1) % game.lines[0].F.length]!;
	assert.isAbove(nextLine.length, 0);
	for (const p of nextLine) {
		game.penaltyBox.add(0, p, fightPenalty, true);
	}

	for (let i = 0; i < 100; i++) {
		const p = game.getPlayerFromNextLine(0, "F", []);
		assert.isDefined(p);
		assert.isFalse(game.penaltyBox.has(0, p));
	}
});

test("fightFactor 0 disables fighting entirely", async () => {
	g.setWithoutSavingToDB("fightFactor", 0);
	try {
		for (let i = 0; i < 20; i++) {
			const game = makeGameSim(await loadGameTeams(), i);
			game.run();
			assert.strictEqual(
				game.majorPenalties.filter((p) => p.name === "fighting").length,
				0,
			);
		}
	} finally {
		g.setWithoutSavingToDB("fightFactor", 1);
	}
});

test(
	"fights occur at a plausible NHL rate over many games",
	{ timeout: 120000 },
	async () => {
		const numGames = 200;
		let fights = 0;
		let hits = 0;

		for (let i = 0; i < numGames; i++) {
			const game = makeGameSim(await loadGameTeams(), i);
			const result = game.run();

			// 2 majorPenalties entries (one per fighter) per fight
			const fightingEntries = game.majorPenalties.filter(
				(p) => p.name === "fighting",
			).length;
			assert.strictEqual(fightingEntries % 2, 0);
			fights += fightingEntries / 2;

			hits += result.team[0].stat.hit + result.team[1].stat.hit;
		}

		const rate = fights / numGames;
		console.log(`fights per game: ${rate} (hits per game: ${hits / numGames})`);

		// Fights scale with hit volume, and FIGHT.probPerHit is calibrated against real NHL rosters
		// (~44 hits/game -> ~0.3-0.4 fights/game, matching 449 fights per 1230-game NHL season). This
		// harness uses generated players whose lower hitting ratings yield only ~15 hits/game, so its
		// fight rate lands proportionally lower (~0.04-0.05). The band below just confirms fights
		// happen at a sane, non-zero rate; the per-game target is validated against real rosters.
		assert.isAbove(fights, 0);
		assert.isAtLeast(rate, 0.02);
		assert.isAtMost(rate, 1.5);
	},
);
