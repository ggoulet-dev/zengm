import { assert, beforeAll, test } from "vitest";
import GameSim from "./index.ts";
import { player, team } from "../index.ts";
import loadTeams from "../game/loadTeams.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { PHASE } from "../../../common/constants.ts";

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

beforeAll(async () => {
	await genTwoTeams();
});

test("overtime goal produces exactly one clutch play for the scorer", async () => {
	g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);

	// 0-0 after regulation, then sudden death until somebody scores
	g.setWithoutSavingToDB("quarterLength", 0);
	g.setWithoutSavingToDB("overtimeLength", 5);
	g.setWithoutSavingToDB("maxOvertimes", null);
	g.setWithoutSavingToDB("shootoutRounds", 0);

	for (let i = 0; i < 5; i++) {
		const game = makeGameSim(await loadGameTeams(), i);
		const result = game.run();

		assert.isAbove(result.overtimes, 0);
		assert.strictEqual(result.clutchPlays.length, 1);
		const clutchPlay = result.clutchPlays[0]!;

		const winner = result.team[0].stat.pts > result.team[1].stat.pts ? 0 : 1;
		assert.deepStrictEqual(clutchPlay.tids, [result.team[winner].id]);

		// The only goal of the game is the OT winner
		const lastEvent = result.scoringSummary.at(-1)!;
		if (lastEvent.type !== "goal") {
			throw new Error("Last scoring event should be the OT goal");
		}
		assert.strictEqual(lastEvent.t, winner);
		assert.deepStrictEqual(clutchPlay.pids, [lastEvent.pids[0]]);

		assert.include(clutchPlay.text, "scored the game-winning goal in");
		assert.include(clutchPlay.text, "overtime");

		// writeGameStats appends the score and a period
		assert.notMatch(clutchPlay.text, /\.$/);
	}
});

test("shootout produces exactly one clutch play for the deciding scorer", async () => {
	g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);

	// 0-0 after regulation and overtime, so every game goes to a shootout
	g.setWithoutSavingToDB("quarterLength", 0);
	g.setWithoutSavingToDB("overtimeLength", 0);
	g.setWithoutSavingToDB("maxOvertimes", 1);
	g.setWithoutSavingToDB("shootoutRounds", 3);

	for (let i = 0; i < 5; i++) {
		const game = makeGameSim(await loadGameTeams(), i);
		const result = game.run();

		assert.strictEqual(result.clutchPlays.length, 1);
		const clutchPlay = result.clutchPlays[0]!;

		const winner = result.team[0].stat.sPts > result.team[1].stat.sPts ? 0 : 1;
		const loser = winner === 0 ? 1 : 0;
		assert.deepStrictEqual(clutchPlay.tids, [result.team[winner].id]);

		// The deciding goal is the winner's goal that exceeded the loser's final total
		const madeShotNames: [string[], string[]] = [[], []];
		for (const event of result.scoringSummary) {
			if (event.type === "shootoutShot" && event.made) {
				madeShotNames[event.t].push(event.names[0]);
			}
		}
		const deciderName =
			madeShotNames[winner][result.team[loser].stat.sPts as number]!;

		const decider = result.team[winner].player.find(
			(p: any) => p.id === clutchPlay.pids[0],
		);
		assert(decider);
		assert.strictEqual(decider.name, deciderName);

		assert.include(clutchPlay.text, deciderName);
		assert.include(clutchPlay.text, "shootout");
		assert.notMatch(clutchPlay.text, /\.$/);
	}
});

test("regulation wins produce zero clutch plays", async () => {
	g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
	g.setWithoutSavingToDB("quarterLength", 20);
	g.setWithoutSavingToDB("overtimeLength", 5);
	g.setWithoutSavingToDB("maxOvertimes", 1);
	g.setWithoutSavingToDB("shootoutRounds", 3);

	let numRegulationGames = 0;
	for (let i = 0; i < 20 && numRegulationGames < 3; i++) {
		const game = makeGameSim(await loadGameTeams(), i);
		const result = game.run();

		if (result.overtimes === 0) {
			numRegulationGames += 1;
			assert.strictEqual(result.clutchPlays.length, 0);
		} else {
			// OT or shootout games still get exactly one
			assert.strictEqual(result.clutchPlays.length, 1);
		}
	}

	assert.isAtLeast(numRegulationGames, 3);
});
