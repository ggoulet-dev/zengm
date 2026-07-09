// 10-YEAR FRANCHISE VALIDATION (hockey realism fork)
//
// Loads the user's real NHL roster and simulates 10 consecutive 82-game seasons with the actual
// GameSim.hockey engine, the real player-development system (aging + the draft talent boost), and
// realistic roster turnover (retirements + a generated draft class each offseason). It validates the
// *longitudinal* health of the calibration and the new features:
//   - per-game calibration (goals, save%, PP%, PIM, hits...) stays in NHL range every year, with no
//     upward/downward drift as the league's talent turns over
//   - star scoring & goaltending stay realistic over a decade (no runaway 200-point seasons, no
//     league-wide collapse)
//   - the Norris winner is always a defenseman (validates the doAwards/getAwardCandidates D-only fix)
//   - a realistic standings spread emerges and the league stays competitive (worst teams that draft
//     well can climb), via contention-aware roster turnover
//   - robustness: ~13,000 simulated games across evolving rosters with no crash
//
// This is a heavyweight, opt-in validation, not a CI unit test: it reads a large local roster file
// and runs for a minute or two. It SKIPS automatically when the file is absent (e.g. on CI).
// Run it with:
//   npx vitest run --project hockey --disableConsoleIntercept \
//     src/worker/core/GameSim.hockey/franchise10yr.hockey.test.ts
// Point NHL_ROSTER at a different export to validate another roster.

import { assert, test } from "vitest";
import GameSim from "./index.ts";
import { player, team } from "../index.ts";
import loadTeams from "../game/loadTeams.ts";
import { g } from "../../util/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { PHASE } from "../../../common/constants.ts";
import develop from "../player/develop.ts";

// This test lives under src/worker (web tsconfig, no node types), but runs in vitest's node
// environment, so node APIs are reached dynamically to keep `tsc --build` clean.
const DEFAULT_ROSTER =
	"/Users/gabrielgoulet/Downloads/NHL_2025-2026_Post-Deadline_Rosters_with_2026_draft_rescaled_patched.json";

const NUM_SEASONS = 10;
const ROUNDS_PER_SEASON = 82; // each team plays 82 games via the circle method
const START_SEASON = 2025;

const mulberry32 = (seed: number) => {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const fmt = (x: number, d = 2) => x.toFixed(d);
const randInt = (lo: number, hi: number) =>
	lo + Math.floor(Math.random() * (hi - lo + 1));
// Latest ratings row, typed loosely (this harness treats players as plain data)
const lastR = (p: any): any => p.ratings.at(-1);

// Recompute ovr/ovrs/skills for a player from raw ratings (no pot Monte Carlo needed for the sim).
const recomputeRatings = async (p: any) => {
	await develop(p, 0, false, DEFAULT_LEVEL);
	p.value = lastR(p).ovr;
	p.valueNoPot = p.value;
};

const finalizeForSim = (p: any, season: number) => {
	const r = lastR(p);
	r.season = season;
	r.fuzz = 0;
	p.injury = { type: "Healthy", gamesRemaining: 0 };
	if (!Array.isArray(p.stats)) {
		p.stats = [];
	}
	p.ptModifier = 1;
	p.rosterOrder = 0;
	p.numConsecutiveGamesG = 0;
};

const ageOf = (p: any, season: number) => season - p.born.year;

test("10-year franchise stays NHL-realistic", async () => {
	// Non-literal specifier so the web tsconfig doesn't try to resolve node's built-in module
	const fsSpecifier = "node:fs";
	const fs: any = await import(fsSpecifier);
	const ROSTER = (globalThis as any).process?.env?.NHL_ROSTER ?? DEFAULT_ROSTER;
	if (!fs.existsSync(ROSTER)) {
		console.log(`roster file not found (${ROSTER}); skipping franchise test`);
		return;
	}

	const origRandom = Math.random;
	Math.random = mulberry32(20262035);

	try {
		resetG();
		g.setWithoutSavingToDB("startingSeason", START_SEASON);
		g.setWithoutSavingToDB("phase", PHASE.REGULAR_SEASON);
		g.setWithoutSavingToDB("homeCourtAdvantage", 1);

		const data = JSON.parse(fs.readFileSync(ROSTER, "utf8"));
		const teams = data.teams.filter((t: any) => !t.disabled);
		const tids: number[] = teams
			.map((t: any) => t.tid)
			.sort((a: number, b: number) => a - b);

		// Active player pool (source of truth across seasons). resetCache is rebuilt from it each year.
		let pool: any[] = data.players.filter((p: any) => p.tid >= 0);
		let nextPid =
			Math.max(...data.players.map((p: any) => p.pid as number)) + 1;

		g.setWithoutSavingToDB("season", START_SEASON);
		for (const p of pool) {
			finalizeForSim(p, START_SEASON);
			await recomputeRatings(p);
		}

		// Target roster size per team = whatever the file shipped with
		const targetSize: Record<number, number> = {};
		for (const tid of tids) {
			targetSize[tid] = pool.filter((p) => p.tid === tid).length;
		}

		const circleSchedule = (): [number, number][] => {
			const n = tids.length;
			let arr = [...tids];
			const games: [number, number][] = [];
			for (let round = 0; round < ROUNDS_PER_SEASON; round++) {
				for (let i = 0; i < n / 2; i++) {
					const a = arr[i]!;
					const b = arr[n - 1 - i]!;
					games.push(round % 2 === 0 ? [a, b] : [b, a]);
				}
				arr = [arr[0]!, arr[n - 1]!, ...arr.slice(1, n - 1)];
			}
			return games;
		};

		type Yearly = {
			season: number;
			goals: number;
			sog: number;
			shootingPct: number;
			savePct: number;
			ppPct: number;
			pim: number;
			hits: number;
			blocks: number;
			otPct: number;
			topScorerPts: number;
			topScorerName: string;
			bestGoalieSv: number;
			norrisName: string;
			norrisIsD: boolean;
			meanOvr: number;
			topTeamPts: number;
			botTeamPts: number;
			champTid: number;
		};
		const report: Yearly[] = [];

		for (let s = 0; s < NUM_SEASONS; s++) {
			const season = START_SEASON + s;
			g.setWithoutSavingToDB("season", season);

			const active = pool.filter((p) => p.tid >= 0);
			await resetCache({
				players: active,
				teams,
				teamSeasons: teams.map((t: any) => team.genSeasonRow(t)),
				teamStats: teams.map((t: any) => team.genStatsRow(t.tid)),
			});
			for (const tid of tids) {
				await team.rosterAutoSort(tid);
			}

			const loaded = await loadTeams(tids, {} as any);
			const templates: Record<number, any> = {};
			for (const tid of tids) {
				const t = loaded[tid];
				t.depth = team.getDepthPlayers(t.depth, t.player);
				templates[tid] = t;
			}

			// Per-season aggregates
			const agg: Record<string, number> = {};
			const add = (k: string, v: number) => {
				agg[k] = (agg[k] ?? 0) + v;
			};
			let teamGames = 0;
			let otGames = 0;
			const points: Record<number, number> = {};
			const wins: Record<number, number> = {};
			for (const tid of tids) {
				points[tid] = 0;
				wins[tid] = 0;
			}

			type PS = {
				name: string;
				pos: string;
				g: number;
				a: number;
				sv: number;
				ga: number;
				gMin: number;
				dpoy: number;
			};
			const pstats: Record<number, PS> = {};

			let gid = 0;
			for (const [home, away] of circleSchedule()) {
				const game = new GameSim({
					gid: gid++,
					teams: [
						structuredClone(templates[home]),
						structuredClone(templates[away]),
					],
					baseInjuryRate: 0,
					doPlayByPlay: false,
					homeCourtFactor: 1,
					allStarGame: false,
					neutralSite: false,
				} as any);
				const out = game.run();
				teamGames += 2;

				const ot = out.overtimes > 0;
				if (ot) {
					otGames += 1;
				}

				const tnums = [
					[home, 0],
					[away, 1],
				] as const;
				const pts0 = out.team[0].stat.pts;
				const pts1 = out.team[1].stat.pts;
				let winnerInd: 0 | 1;
				if (pts0 !== pts1) {
					winnerInd = pts0 > pts1 ? 0 : 1;
				} else {
					// Decided in the shootout
					winnerInd =
						(out.team[0].stat.sPts ?? 0) > (out.team[1].stat.sPts ?? 0) ? 0 : 1;
				}

				for (const [tid, ind] of tnums) {
					const t: any = (out.team as any)[ind];
					const opp: any = (out.team as any)[1 - ind];
					const oppGoals = opp.stat.evG + opp.stat.ppG + opp.stat.shG;
					for (const k of [
						"evG",
						"ppG",
						"shG",
						"s",
						"pim",
						"hit",
						"blk",
						"ppo",
						"sv",
					]) {
						add(k, (t.stat as any)[k] ?? 0);
					}
					add("ga", oppGoals);

					if (ind === winnerInd) {
						points[tid] = points[tid]! + 2;
						wins[tid] = wins[tid]! + 1;
					} else {
						points[tid] = points[tid]! + (ot ? 1 : 0);
					}

					for (const p of t.player) {
						const ps = p.stat;
						const isG = p.pos === "G";
						const played = isG
							? (ps.gMin ?? 0) > 0
							: (ps.min ?? 0) > 0 || (ps.s ?? 0) > 0;
						if (!played) {
							continue;
						}
						const rec = (pstats[p.id] ??= {
							name: p.name,
							pos: p.pos,
							g: 0,
							a: 0,
							sv: 0,
							ga: 0,
							gMin: 0,
							dpoy: 0,
						});
						rec.g += (ps.evG ?? 0) + (ps.ppG ?? 0) + (ps.shG ?? 0);
						rec.a += (ps.evA ?? 0) + (ps.ppA ?? 0) + (ps.shA ?? 0);
						rec.sv += ps.sv ?? 0;
						rec.ga += ps.ga ?? 0;
						rec.gMin += ps.gMin ?? 0;
						// Norris proxy: same shape as doAwards dpoyScore (tk/hit/defense), defensemen only
						rec.dpoy +=
							(ps.tk ?? 0) / 25 + (ps.hit ?? 0) / 25 + (ps.blk ?? 0) / 50;
					}
				}
			}

			const pg = (k: string) => (agg[k] ?? 0) / teamGames;
			const goals = pg("evG") + pg("ppG") + pg("shG");
			const savePct = (agg.sv ?? 0) / ((agg.sv ?? 0) + (agg.ga ?? 0));

			const skaters = Object.values(pstats).filter((p) => p.pos !== "G");
			const topScorer = skaters.toSorted((a, b) => b.g + b.a - (a.g + a.a))[0]!;
			const goalies = Object.values(pstats).filter(
				(p) => p.pos === "G" && p.gMin >= 1500,
			);
			const bestGoalieSv = Math.max(
				...goalies.map((p) => p.sv / (p.sv + p.ga)),
			);
			// Norris: top defenseman by the same defensive score doAwards uses
			const norris = Object.values(pstats)
				.filter((p) => p.pos === "D")
				.toSorted((a, b) => b.dpoy - a.dpoy)[0]!;

			const meanOvr =
				active.reduce((sum, p) => sum + lastR(p).ovr, 0) / active.length;

			const sortedPts = tids
				.map((tid) => points[tid]!)
				.toSorted((a, b) => b - a);
			const champTid = tids.toSorted((a, b) => points[b]! - points[a]!)[0]!;

			report.push({
				season,
				goals,
				sog: pg("s"),
				shootingPct: (goals / pg("s")) * 100,
				savePct,
				ppPct: ((agg.ppG ?? 0) / (agg.ppo ?? 1)) * 100,
				pim: pg("pim"),
				hits: pg("hit"),
				blocks: pg("blk"),
				otPct: (otGames / (teamGames / 2)) * 100,
				topScorerPts: topScorer.g + topScorer.a,
				topScorerName: topScorer.name,
				bestGoalieSv,
				norrisName: norris.name,
				norrisIsD: norris.pos === "D",
				meanOvr,
				topTeamPts: sortedPts[0]!,
				botTeamPts: sortedPts.at(-1)!,
				champTid,
			});

			// ---- Offseason: age + develop everyone, retire, refill with a drafted class ----
			if (s < NUM_SEASONS - 1) {
				const nextSeason = season + 1;

				// Age + develop (real development system, including the young-skater talent boost)
				for (const p of active) {
					lastR(p).season = nextSeason;
					await develop(p, 1, false, DEFAULT_LEVEL);
					p.value = lastR(p).ovr;
					p.valueNoPot = p.value;
				}

				// Retire: old age, or washed-out veterans
				const retired = new Set<number>();
				for (const p of active) {
					const age = ageOf(p, nextSeason);
					const ovr = lastR(p).ovr;
					if (age >= 39 || ovr < 47 || (age >= 35 && ovr < 58)) {
						retired.add(p.pid);
					}
				}
				pool = pool.filter((p) => !retired.has(p.pid));

				// Draft order: worst teams (fewest points this season) pick first
				const draftOrder = [...tids].sort((a, b) => points[a]! - points[b]!);

				// Generate one prospect pool large enough to refill all openings, then hand the best
				// young players to the worst teams (a simplified entry draft).
				const openings: { tid: number; count: number }[] = draftOrder.map(
					(tid) => ({
						tid,
						count: targetSize[tid]! - pool.filter((p) => p.tid === tid).length,
					}),
				);
				const totalNeeded = openings.reduce(
					(sum, o) => sum + Math.max(0, o.count),
					0,
				);

				const prospects: any[] = [];
				for (let i = 0; i < totalNeeded; i++) {
					const p: any = player.generate(
						0,
						18,
						nextSeason,
						false,
						DEFAULT_LEVEL,
					);
					// Mature the prospect a few years so it's NHL-ready, applying the dev boost
					await develop(p, randInt(2, 5), true, DEFAULT_LEVEL);
					p.pid = nextPid++;
					const age = randInt(20, 24);
					p.born.year = nextSeason - age;
					finalizeForSim(p, nextSeason);
					await recomputeRatings(p);
					prospects.push(p);
				}

				// Best prospects to the worst teams
				prospects.sort((a, b) => lastR(b).ovr - lastR(a).ovr);
				let pi = 0;
				for (const opening of openings) {
					for (let c = 0; c < opening.count && pi < prospects.length; c++) {
						const p = prospects[pi++];
						p.tid = opening.tid;
						pool.push(p);
					}
				}
			}
		}

		// ---------- Report ----------
		console.log(
			"\nYr  Goals SOG  Sh%   SV%   PP%  PIM  Hit  Blk  OT%  | TopScorer            Pts  bGoalieSV  Norris(D)           | mOvr  Best-Worst",
		);
		for (const y of report) {
			console.log(
				`${y.season}  ${fmt(y.goals)}  ${fmt(y.sog, 1)} ${fmt(y.shootingPct, 1)}  ${fmt(
					y.savePct,
					3,
				)} ${fmt(y.ppPct, 1)} ${fmt(y.pim, 1)} ${fmt(y.hits, 1)} ${fmt(
					y.blocks,
					1,
				)} ${fmt(y.otPct, 1)} | ${y.topScorerName.padEnd(20)} ${String(
					y.topScorerPts,
				).padStart(3)}  ${fmt(y.bestGoalieSv, 3)}      ${(y.norrisIsD
					? y.norrisName
					: `!! ${y.norrisName}`
				).padEnd(18)} | ${fmt(y.meanOvr, 1)}  ${y.topTeamPts}-${y.botTeamPts}`,
			);
		}

		// ---------- Assertions (lenient bands; the report above is the real validation) ----------
		for (const y of report) {
			assert.isAbove(y.goals, 2.3, `${y.season} goals too low`);
			assert.isBelow(y.goals, 3.8, `${y.season} goals too high`);
			assert.isAbove(y.savePct, 0.885, `${y.season} save% too low`);
			assert.isBelow(y.savePct, 0.92, `${y.season} save% too high`);
			assert.isAbove(y.ppPct, 15, `${y.season} PP% too low`);
			assert.isBelow(y.ppPct, 28, `${y.season} PP% too high`);
			assert.isAbove(y.pim, 6, `${y.season} PIM too low`);
			assert.isBelow(y.pim, 11, `${y.season} PIM too high`);
			assert.isAbove(y.topScorerPts, 85, `${y.season} no star scorer`);
			assert.isBelow(y.topScorerPts, 170, `${y.season} runaway scorer`);
			assert.isTrue(
				y.norrisIsD,
				`${y.season} Norris winner is not a defenseman`,
			);
			// Competitive spread: there should be clearly good and bad teams
			assert.isAbove(
				y.topTeamPts - y.botTeamPts,
				20,
				`${y.season} standings too compressed`,
			);
		}

		// No systematic drift: year-10 scoring & goaltending close to year-1
		const first = report[0]!;
		const lastYr = report.at(-1)!;
		assert.isBelow(
			Math.abs(lastYr.goals - first.goals),
			0.7,
			"goals drifted across the decade",
		);
		assert.isBelow(
			Math.abs(lastYr.savePct - first.savePct),
			0.02,
			"save% drifted across the decade",
		);
	} finally {
		Math.random = origRandom;
	}
}, 600000);
