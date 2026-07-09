import { assert, beforeAll, test, vi } from "vitest";
import GameSim from "../GameSim.hockey/index.ts";
import { player, team } from "../index.ts";
import loadTeams from "./loadTeams.ts";
import writePlayerStats from "./writePlayerStats.ts";
import { idb } from "../../db/index.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import {
	applySuspension,
	getEffectivePlayThroughInjuries,
	getSuspensionProb,
	rollSuspensionGames,
	SUSPENSION_GAMES_LONG,
	SUSPENSION_GAMES_SHORT,
	SUSPENSION_INJURY_TYPE,
	SUSPENSION_PROB_FIGHTING,
	SUSPENSION_PROB_OTHER_MAJOR,
	SUSPENSION_PROB_SEVERE,
} from "./suspension.hockey.ts";

// Rigged RNG: returns the queued values in order, repeating the last one
const seq = (...values: number[]) => {
	let i = 0;
	return () => {
		const value = values[Math.min(i, values.length - 1)]!;
		i += 1;
		return value;
	};
};

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

beforeAll(async () => {
	await genTwoTeams();
});

test("getSuspensionProb maps penalty names to the right category", () => {
	assert.strictEqual(getSuspensionProb("fighting"), SUSPENSION_PROB_FIGHTING);
	for (const name of [
		"illegal check to the head",
		"boarding",
		"checking from behind",
	]) {
		assert.strictEqual(getSuspensionProb(name), SUSPENSION_PROB_SEVERE);
	}
	assert.strictEqual(
		getSuspensionProb("elbowing"),
		SUSPENSION_PROB_OTHER_MAJOR,
	);
});

test("rollSuspensionGames returns undefined when the probability roll fails", () => {
	// First roll exactly at the probability threshold fails (roll >= prob)
	assert.isUndefined(
		rollSuspensionGames("fighting", seq(SUSPENSION_PROB_FIGHTING)),
	);
	assert.isUndefined(rollSuspensionGames("boarding", seq(0.99)));
});

test("rollSuspensionGames lengths span 1-3 games normally and 4-8 occasionally", () => {
	// Short range: prob roll passes, long roll fails
	assert.strictEqual(
		rollSuspensionGames("fighting", seq(0, 0.99, 0)),
		SUSPENSION_GAMES_SHORT[0],
	);
	assert.strictEqual(
		rollSuspensionGames("fighting", seq(0, 0.99, 0.999)),
		SUSPENSION_GAMES_SHORT[1],
	);

	// Long range: prob roll passes, long roll passes
	assert.strictEqual(
		rollSuspensionGames("illegal check to the head", seq(0, 0, 0)),
		SUSPENSION_GAMES_LONG[0],
	);
	assert.strictEqual(
		rollSuspensionGames("illegal check to the head", seq(0, 0, 0.999)),
		SUSPENSION_GAMES_LONG[1],
	);
});

test("applySuspension on a healthy player sets the fake injury and appends history", () => {
	const p: any = { injury: { type: "Healthy", gamesRemaining: 0 } };
	const p2: any = {
		injury: { type: "Healthy", gamesRemaining: 0 },
		injuries: [],
	};

	const becameActive = applySuspension(p, p2, 2, 2013, 0, 10);

	assert.isTrue(becameActive);
	assert.strictEqual(p2.injury.type, SUSPENSION_INJURY_TYPE);
	// +1 because the end-of-day countdown runs the same day, so the player actually sits 2 games
	assert.strictEqual(p2.injury.gamesRemaining, 3);
	assert.isAtLeast(p2.injury.gamesRemaining, 1);
	assert.strictEqual(p2.injury.score, 10);
	assert.deepStrictEqual(p2.injuries, [
		{ season: 2013, games: 2, type: SUSPENSION_INJURY_TYPE },
	]);
	assert.deepStrictEqual(p.injury, {
		type: SUSPENSION_INJURY_TYPE,
		gamesRemaining: 3,
		newThisGame: true,
	});
});

test("a longer real injury from the same game takes precedence, but history is still appended", () => {
	const p: any = { injury: { type: "Broken leg", gamesRemaining: 20 } };
	const p2: any = {
		injury: { type: "Broken leg", gamesRemaining: 20, score: 20 },
		injuries: [{ season: 2013, games: 20, type: "Broken leg" }],
	};

	const becameActive = applySuspension(p, p2, 3, 2013, 0, 10);

	assert.isFalse(becameActive);
	assert.strictEqual(p2.injury.type, "Broken leg");
	assert.strictEqual(p2.injury.gamesRemaining, 20);
	assert.strictEqual(p2.injuries.length, 2);
	assert.deepStrictEqual(p2.injuries.at(-1), {
		season: 2013,
		games: 3,
		type: SUSPENSION_INJURY_TYPE,
	});
});

test("a suspension longer than a real injury from the same game becomes the active injury", () => {
	const p: any = { injury: { type: "Sprained ankle", gamesRemaining: 2 } };
	const p2: any = {
		injury: { type: "Sprained ankle", gamesRemaining: 2, score: 0 },
		injuries: [{ season: 2013, games: 2, type: "Sprained ankle" }],
	};

	const becameActive = applySuspension(p, p2, 5, 2013, 0, 10);

	assert.isTrue(becameActive);
	assert.strictEqual(p2.injury.type, SUSPENSION_INJURY_TYPE);
	assert.strictEqual(p2.injury.gamesRemaining, 6);
});

test("a playable-through real injury does not excuse the suspension", () => {
	// With a play-through cutoff of 4, a 3-game injury would not keep the player out, so a 1-game
	// suspension must become the active injury even though the injury countdown is longer
	const p: any = {
		injury: { type: "Back spasms", gamesRemaining: 3, playingThrough: true },
	};
	const p2: any = {
		injury: { type: "Back spasms", gamesRemaining: 3, score: 0 },
		injuries: [{ season: 2013, games: 3, type: "Back spasms" }],
	};

	const becameActive = applySuspension(p, p2, 1, 2013, 4, 0);

	assert.isTrue(becameActive);
	assert.strictEqual(p2.injury.type, SUSPENSION_INJURY_TYPE);
	// The longer injury countdown is preserved, so it's served concurrently with the suspension
	assert.strictEqual(p2.injury.gamesRemaining, 3);
	// The played-through injury at game start is saved for the box score
	assert.deepStrictEqual(p.injuryAtStart, {
		type: "Back spasms",
		gamesRemaining: 3,
	});
});

test("a real injury still takes precedence when it outlasts the suspension beyond the cutoff", () => {
	// Injury countdown stays above the cutoff of 4 for the whole 1-game suspension (8 - 1 > 4), so
	// the player sits anyway and the suspension is served concurrently
	const p: any = { injury: { type: "Back spasms", gamesRemaining: 8 } };
	const p2: any = {
		injury: { type: "Back spasms", gamesRemaining: 8, score: 0 },
		injuries: [{ season: 2013, games: 8, type: "Back spasms" }],
	};

	const becameActive = applySuspension(p, p2, 1, 2013, 4, 0);

	assert.isFalse(becameActive);
	assert.strictEqual(p2.injury.type, "Back spasms");
	assert.strictEqual(p2.injury.gamesRemaining, 8);
});

test("suspensions can never be played through", () => {
	assert.strictEqual(
		getEffectivePlayThroughInjuries(
			{ type: SUSPENSION_INJURY_TYPE, gamesRemaining: 2 },
			5,
		),
		0,
	);
	assert.strictEqual(
		getEffectivePlayThroughInjuries(
			{ type: "Sprained ankle", gamesRemaining: 2 },
			5,
		),
		5,
	);
});

test(
	"end to end: a major penalty flows out of GameSim and writePlayerStats suspends the player",
	{ timeout: 120000 },
	async () => {
		const game = new GameSim({
			gid: 0,
			teams: await loadGameTeams(),
			baseInjuryRate: 0,
			doPlayByPlay: false,
			homeCourtFactor: 1,
			allStarGame: false,
			neutralSite: false,
		});
		const result: any = game.run();

		// Majors flow out of run() - they can't be reconstructed from stats, which only have pim
		assert.strictEqual(result.majorPenalties, game.majorPenalties);

		// Force a single major for a skater who played, then make every roll succeed
		const skater = result.team[0].player.find(
			(p: any) => p.pos !== "G" && p.stat.min > 0 && !p.injured,
		);
		assert.isDefined(skater);
		result.majorPenalties = [
			{ pid: skater.id, name: "illegal check to the head" },
		];

		const spy = vi.spyOn(Math, "random").mockReturnValue(0);
		try {
			await writePlayerStats([result], {});
		} finally {
			spy.mockRestore();
		}

		const p2 = await idb.cache.players.get(skater.id);
		assert.isDefined(p2);
		assert.strictEqual(p2!.injury.type, SUSPENSION_INJURY_TYPE);
		assert.isAtLeast(p2!.injury.gamesRemaining, 1);
		// Math.random() === 0 -> long range minimum (4 games), +1 for the same-day countdown
		assert.strictEqual(p2!.injury.gamesRemaining, SUSPENSION_GAMES_LONG[0] + 1);
		assert.deepStrictEqual(p2!.injuries.at(-1), {
			season: 2013,
			games: SUSPENSION_GAMES_LONG[0],
			type: SUSPENSION_INJURY_TYPE,
		});

		// A suspension news event was logged
		const events = (await idb.cache.events.getAll()).filter(
			(event: any) =>
				event.type === "injured" && event.pids?.includes(skater.id),
		);
		assert.isAtLeast(events.length, 1);
		assert.include((events.at(-1) as any).text, "suspended");

		// Even with a huge playThroughInjuries setting, the suspended player is excluded from the lineup
		for (const tid of [0, 1]) {
			const t = await idb.cache.teams.get(tid);
			t!.playThroughInjuries = [10, 10];
			await idb.cache.teams.put(t!);
		}

		const teams = await loadTeams([0, 1], {});
		const suspended = teams[0].player.find((p: any) => p.id === skater.id);
		assert.isDefined(suspended);
		assert.isTrue(suspended.injured);
		assert.isFalse(suspended.injury.playingThrough);

		// While a regular injury of the same length IS played through with that setting
		const other = result.team[0].player.find(
			(p: any) => p.pos !== "G" && p.id !== skater.id,
		);
		const otherP2 = await idb.cache.players.get(other.id);
		otherP2!.injury = {
			type: "Sprained ankle",
			gamesRemaining: SUSPENSION_GAMES_LONG[0] + 1,
		};
		await idb.cache.players.put(otherP2!);

		const teams2 = await loadTeams([0, 1], {});
		const walkingWounded = teams2[0].player.find((p: any) => p.id === other.id);
		assert.isFalse(walkingWounded.injured);
		assert.isTrue(walkingWounded.injury.playingThrough);
	},
);

test(
	"a suspension is served even when the player is playing through a longer injury",
	{ timeout: 120000 },
	async () => {
		// User team plays through injuries up to 4 games (also the AI default in the playoffs)
		for (const tid of [0, 1]) {
			const t = await idb.cache.teams.get(tid);
			t!.playThroughInjuries = [4, 4];
			await idb.cache.teams.put(t!);
		}

		// Probe game to find a healthy skater who actually plays
		const probe: any = new GameSim({
			gid: 1,
			teams: await loadGameTeams(),
			baseInjuryRate: 0,
			doPlayByPlay: false,
			homeCourtFactor: 1,
			allStarGame: false,
			neutralSite: false,
		}).run();
		const skater = probe.team[0].player.find(
			(p: any) => p.pos !== "G" && p.stat.min > 0 && !p.injured,
		);
		assert.isDefined(skater);

		// Give him a 3-game injury that he plays through
		const before = await idb.cache.players.get(skater.id);
		before!.injury = { type: "Back spasms", gamesRemaining: 3 };
		await idb.cache.players.put(before!);

		const teams = await loadGameTeams();
		const pregame = teams[0].player.find((p: any) => p.id === skater.id);
		assert.isTrue(pregame.injury.playingThrough);
		assert.isFalse(pregame.injured);

		const game = new GameSim({
			gid: 2,
			teams,
			baseInjuryRate: 0,
			doPlayByPlay: false,
			homeCourtFactor: 1,
			allStarGame: false,
			neutralSite: false,
		});
		const result: any = game.run();
		const boxScoreP = result.team[0].player.find(
			(p: any) => p.id === skater.id,
		);
		assert.isDefined(boxScoreP);
		assert.isAbove(boxScoreP.stat.min, 0);

		// Rig a 1-game suspension: prob roll passes, long roll fails (0.5 >= 0.15), length roll 0 -> 1
		// game. With baseInjuryRate 0 nothing else in writePlayerStats consumes Math.random.
		result.majorPenalties = [{ pid: skater.id, name: "boarding" }];
		const spy = vi.spyOn(Math, "random").mockImplementation(seq(0, 0.5, 0));
		try {
			await writePlayerStats([result], {});
		} finally {
			spy.mockRestore();
		}

		// The playable-through injury must not swallow the suspension - it becomes a suspension
		// covering the remaining injury countdown too
		const after = await idb.cache.players.get(skater.id);
		assert.strictEqual(after!.injury.type, SUSPENSION_INJURY_TYPE);
		assert.strictEqual(after!.injury.gamesRemaining, 3);
		assert.deepStrictEqual(after!.injuries.at(-1), {
			season: 2013,
			games: 1,
			type: SUSPENSION_INJURY_TYPE,
		});

		// Next game, the player actually sits despite the play-through setting
		const teamsAfter = await loadTeams([0, 1], {});
		const suspended = teamsAfter[0].player.find((p: any) => p.id === skater.id);
		assert.isTrue(suspended.injured);
		assert.isFalse(suspended.injury.playingThrough);
	},
);
