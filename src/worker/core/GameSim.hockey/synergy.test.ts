import { assert, beforeAll, test } from "vitest";
import GameSim from "./index.ts";
import { player, team } from "../index.ts";
import loadTeams from "../game/loadTeams.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";

const genTwoTeams = async () => {
	resetG();
	g.setWithoutSavingToDB("season", 2013);

	// Keep the two teams strictly symmetric for the deterministic test below
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

test("complementarity of realistic rosters stays within the bounds", async () => {
	const game = makeGameSim(await loadGameTeams());

	for (const t of [0, 1] as const) {
		const complementarity = game.getLineComplementarity(t);
		console.log(`team ${t} starters complementarity: ${complementarity}`);
		assert.isAtLeast(complementarity, -0.05);
		assert.isAtMost(complementarity, 0.03);
	}
});

test("a balanced unit gets a higher effective strength than a line of snipers", async () => {
	const game = makeGameSim(await loadGameTeams());

	// Mutate the actual on-ice units (in hockey every skater appears in both the F and D depth lists, so mutating via depth would double-apply), then recompute
	const setOnIceRatings = (
		t: 0 | 1,
		forwards: { playmaker: number; sniper: number },
	) => {
		for (const p of [...game.playersOnIce[t].C, ...game.playersOnIce[t].W]) {
			p.compositeRating.playmaker = forwards.playmaker;
			p.compositeRating.sniper = forwards.sniper;
			p.ovrs = { ...p.ovrs, C: 60, W: 60, D: 60 };
		}
		for (const p of game.playersOnIce[t].D) {
			p.compositeRating.playmaker = 0.3;
			p.compositeRating.blocking = 0.5;
			p.ovrs = { ...p.ovrs, C: 60, W: 60, D: 60 };
		}
	};

	// Same raw strength on both sides, but team 0 has creators AND finishers while team 1 only has finishers
	setOnIceRatings(0, { playmaker: 0.6, sniper: 0.6 });
	setOnIceRatings(1, { playmaker: 0.15, sniper: 0.6 });

	game.updateTeamCompositeRatings();

	// Base strength is 5 skaters x 60 / 500 = 0.6 on both sides. Team 0: F balanced (+0.015), D pair (-0.005). Team 1: F all snipers (-0.03), D pair (-0.005).
	assert.closeTo(game.team[0].synergy.reb, 0.6 * 1.01, 1e-9);
	assert.closeTo(game.team[1].synergy.reb, 0.6 * 0.965, 1e-9);
});

test("synergy does not move the league goal rate", async () => {
	const numGames = 150;

	const measure = async () => {
		let totalGoals = 0;
		for (let i = 0; i < numGames; i++) {
			const result = makeGameSim(await loadGameTeams(), i).run();
			totalGoals += result.team[0].stat.pts + result.team[1].stat.pts;
		}
		return totalGoals / numGames;
	};

	const withSynergy = await measure();

	const orig = GameSim.prototype.getLineComplementarity;
	let withoutSynergy;
	try {
		GameSim.prototype.getLineComplementarity = () => 0;
		withoutSynergy = await measure();
	} finally {
		GameSim.prototype.getLineComplementarity = orig;
	}

	// Catches catastrophic breakage (NaN save percentage etc.)
	assert.isAbove(withSynergy, 3);
	assert.isBelow(withSynergy, 12);

	// Complementarity is centered, so the league-wide goal rate should not shift. SE of the difference at 150 games each is ~0.4 goals.
	assert.closeTo(withSynergy, withoutSynergy, 1.2);
});
