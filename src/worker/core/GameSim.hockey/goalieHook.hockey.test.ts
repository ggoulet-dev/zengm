import { assert, beforeAll, test } from "vitest";
import GameSim, { GOALIE_HOOK } from "./index.ts";
import { player, team } from "../index.ts";
import loadTeams from "../game/loadTeams.ts";
import { g, helpers } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { orderBy } from "../../../common/utils.ts";

// Seeded PRNG so the league talent and the 300-game hook-rate sample are
// reproducible. An unseeded 2-team harness swings wildly run-to-run, which made
// the hook-rate assertion flaky right at the band edges.
const mulberry32 = (a: number) => () => {
	a |= 0;
	a = (a + 0x6d2b79f5) | 0;
	let t = Math.imul(a ^ (a >>> 15), 1 | a);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Random test rosters can end up with zero usable goalies (and near-flat ovrs), making depth.G ordering arbitrary and the "backup" a skater who is also dressed on a line. Force two real goalies per team by editing ratings and recomputing ovrs/pos via develop(p, 0), like a God Mode edit.
const forceGoalie = async (p: any, glk: number) => {
	const ratings = p.ratings.at(-1);
	for (const key of Object.keys(ratings)) {
		if (typeof ratings[key] === "number" && key !== "season") {
			ratings[key] = 0;
		}
	}
	ratings.glk = glk;
	// Position is explicit, like a God Mode edit: develop never moves a skater to G
	ratings.pos = "G";
	await player.develop(p, 0, false, DEFAULT_LEVEL, true);
};

const genTwoTeams = async () => {
	resetG();
	g.setWithoutSavingToDB("season", 2013);
	g.setWithoutSavingToDB("homeCourtAdvantage", 0);

	const teamsDefault = helpers.getTeamsDefault().slice(0, 2);

	// Deterministic talent generation.
	const origRandom = Math.random;
	Math.random = mulberry32(20240615);

	const players = [];
	for (const tid of [0, 1]) {
		for (let i = 0; i < 30; i++) {
			const p = player.generate(tid, 25, 2010, true, DEFAULT_LEVEL);

			// Without develop, ovrs are all 0 and the sim degenerates (NaN save percentage)
			await player.develop(p, 6, false, DEFAULT_LEVEL);

			// Guarantee a real starter and backup goalie, so the hook always has a backup available. Use NHL-starter-caliber glk (not a weak 50-60) so the hook rate reflects a real starter's bad nights, not a scrub getting shelled every game.
			if (i < 2) {
				await forceGoalie(p, i === 0 ? 80 : 68);
			}

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

	Math.random = origRandom;
};

const loadGameTeams = async () => {
	const teams = await loadTeams([0, 1], {});
	for (const t of [teams[0], teams[1]]) {
		if (t.depth !== undefined) {
			// The degenerate test rosters give rosterAutoSort near-flat ovrs, which can dress a goalie on a skater line. Build a sane depth chart explicitly: the two real goalies in G only, skaters in F/D.
			// loadTeams deletes p.pid from its player objects, so key by p.id (getDepthPlayers falls back to it)
			const goalies = orderBy(t.player, (p: any) => p.ovrs.G, "desc").slice(
				0,
				2,
			);
			const goalieIds = new Set(goalies.map((p: any) => p.id));
			const skaters = t.player.filter((p: any) => !goalieIds.has(p.id));
			t.depth = team.getDepthPlayers(
				{
					F: orderBy(skaters, (p: any) => p.ovrs.C, "desc").map(
						(p: any) => p.id,
					),
					D: orderBy(skaters, (p: any) => p.ovrs.D, "desc").map(
						(p: any) => p.id,
					),
					G: goalies.map((p: any) => p.id),
				} as any,
				t.player,
			);
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

beforeAll(async () => {
	await genTwoTeams();
});

test("a struggling starter is hooked for the backup, who stays in everywhere", async () => {
	const game = makeGameSim(await loadGameTeams(), 0, true);

	const starter = game.playersOnIce[0].G[0]!;
	const backup = game.backupGoalies[0]!;
	assert.isDefined(backup);
	assert.notStrictEqual(backup, starter);
	assert.strictEqual(game.lines[0].G[0]![0], starter);

	// Below the trigger with a decent save fraction: no hook
	starter.stat.ga = GOALIE_HOOK.gaAnytime - 1;
	starter.stat.sv = 50;
	game.checkGoalieHook(0);
	assert.isFalse(game.hookedGoalie[0]);
	assert.strictEqual(game.playersOnIce[0].G[0], starter);

	// At the anytime threshold: hooked
	starter.stat.ga = GOALIE_HOOK.gaAnytime;
	game.checkGoalieHook(0);

	assert.isTrue(game.hookedGoalie[0]);
	assert.strictEqual(game.playersOnIce[0].G[0], backup);

	// lines.G points at the backup too, so the shootout goalie pick and noPullGoalie restore agree
	assert.strictEqual(game.lines[0].G[0]![0], backup);

	// gpGoalie auto-recorded via the substitutions branch
	assert.strictEqual(backup.stat.gpGoalie, 1);

	// gMin now accrues to the backup
	const gMinBefore = backup.stat.gMin;
	game.updatePlayingTime(1);
	assert.isAbove(backup.stat.gMin, gMinBefore);

	// Play-by-play logged the hook
	assert.isTrue(
		game.playByPlay.playByPlay.some((event) => event.type === "goalieHook"),
	);

	// At most one hook per game: even if the backup also struggles, no further change
	backup.stat.ga = GOALIE_HOOK.gaAnytime;
	backup.stat.sv = 0;
	game.checkGoalieHook(0);
	assert.strictEqual(game.playersOnIce[0].G[0], backup);

	// The hooked starter does not return on normal updates, new periods, or new lines after an injury
	game.updatePlayersOnIce({ type: "normal" });
	game.updatePlayersOnIce({ type: "newPeriod" });
	assert.strictEqual(game.playersOnIce[0].G[0], backup);
	game.setLines();
	assert.strictEqual(game.lines[0].G[0]![0], backup);
	assert.strictEqual(game.playersOnIce[0].G[0], backup);

	// Other team is untouched
	assert.isFalse(game.hookedGoalie[1]);
});

test("no hook while the goalie is pulled for an extra attacker", async () => {
	const game = makeGameSim(await loadGameTeams());

	const starter = game.playersOnIce[1].G[0]!;
	starter.stat.ga = GOALIE_HOOK.gaAnytime;
	game.pulledGoalie[1] = true;
	game.playersOnIce[1].G = [];

	game.checkGoalieHook(1);

	assert.isFalse(game.hookedGoalie[1]);
	assert.deepStrictEqual(game.playersOnIce[1].G, []);
	// noPullGoalie restore still finds the original starter in lines.G
	assert.strictEqual(game.lines[1].G[0]![0], starter);
});

test("no hook when there is no healthy natural backup goalie", async () => {
	const teams = await loadGameTeams();

	// Only one healthy natural goalie per team: the real backup is hurt, and the rest of depth.G is skaters, like the roster-wide depth.G sorted by goalie rating in real leagues
	for (const t of teams) {
		const [starterG, backupG] = t.depth.G;
		backupG.injured = true;
		const skaters = t.player.filter(
			(p: any) => p !== starterG && p !== backupG && p.pos !== "G",
		);
		t.depth.G = [starterG, backupG, ...skaters];
	}

	const game = makeGameSim(teams);

	// A skater must never be stashed as the backup goalie...
	assert.isUndefined(game.backupGoalies[0]);
	assert.isUndefined(game.backupGoalies[1]);

	// ...so the starter stays in, no matter how badly he is shelled
	const starter = game.playersOnIce[0].G[0]!;
	assert.strictEqual(starter.pos, "G");
	starter.stat.ga = GOALIE_HOOK.gaAnytime + 2;
	starter.stat.sv = 0;
	game.checkGoalieHook(0);
	assert.isFalse(game.hookedGoalie[0]);
	assert.strictEqual(game.playersOnIce[0].G[0], starter);
});

test("no hook without a healthy backup", async () => {
	const game = makeGameSim(await loadGameTeams());

	const starter = game.playersOnIce[0].G[0]!;
	starter.stat.ga = GOALIE_HOOK.gaAnytime;
	game.backupGoalies[0] = undefined;

	game.checkGoalieHook(0);
	assert.isFalse(game.hookedGoalie[0]);
	assert.strictEqual(game.playersOnIce[0].G[0], starter);
});

test(
	"starters get hooked at an NHL-like rate over many games",
	{ timeout: 120000 },
	async () => {
		const numGames = 300;
		let hooks = 0;

		// Seed the sample so the measured rate is reproducible (not flaky).
		const origRandom = Math.random;
		Math.random = mulberry32(424242);

		try {
			for (let i = 0; i < numGames; i++) {
				const game = makeGameSim(await loadGameTeams(), i);
				const starters = [
					game.playersOnIce[0].G[0]!,
					game.playersOnIce[1].G[0]!,
				];
				const backups = [game.backupGoalies[0], game.backupGoalies[1]];

				game.run();

				for (const t of [0, 1] as const) {
					if (game.hookedGoalie[t]) {
						hooks += 1;

						const backup = backups[t]!;
						assert.strictEqual(game.lines[t].G[0]![0], backup);
						assert.strictEqual(backup.stat.gpGoalie, 1);
						assert.isAbove(backup.stat.gMin, 0);

						// The relieved starter never came back (G can be empty if the game ended with the goalie pulled)
						assert.notStrictEqual(game.playersOnIce[t].G[0], starters[t]);

						// Both goalies played, so the starter cannot have a full-game stat line
						assert.isBelow(
							starters[t]!.stat.gMin,
							g.get("quarterLength") * g.get("numPeriods"),
						);
					}
				}
			}
		} finally {
			Math.random = origRandom;
		}

		const rate = hooks / (2 * numGames);
		console.log(`goalie hook rate per team-game: ${rate}`);

		// Target is roughly 3-6% of team-games; generous band to avoid flakiness
		assert.isAbove(hooks, 0);
		assert.isAtLeast(rate, 0.01);
		assert.isAtMost(rate, 0.12);
	},
);
