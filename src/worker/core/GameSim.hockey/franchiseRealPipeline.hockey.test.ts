// REAL-PIPELINE FRANCHISE HARNESS (hockey realism fork)
//
// Creates a league exactly like the "upload a league file" path does, then auto-plays N seasons through
// the game's own phase pipeline: schedule, playoffs, lottery, draft (with the blue-chip boost), re-signing,
// free agency, AI roster management, farm system, salary cap, retirements. franchise10yr replaces the
// offseason with a simplified develop/retire/refill loop; this harness measures what the game itself does
// over a long horizon: league talent level, standings spread, position mix, star scoring.
//
// Opt-in validation (skips when the roster file is absent). Env:
//   NHL_ROSTER=path   league file to start from (default below)
//   NHL_SEASONS=20    seasons to play (default 10)
//   NHL_RANDOM=1      random players on the file's teams/settings: the game's native baseline
// Run with:
//   NHL_SEASONS=20 npx vitest --run --project hockey --reporter=verbose --silent=false franchiseRealPipeline
// (the default reporter hides the report when the test passes)

import "fake-indexeddb/auto";
import { assert, test } from "vitest";
import { league } from "../index.ts";
import { idb } from "../../db/index.ts";
import { g, helpers, local } from "../../util/index.ts";
import createStreamFromLeagueObject from "../league/create/createStreamFromLeagueObject.ts";
import { getDefaultSettings } from "../../views/newLeague.ts";
import { unwrapGameAttribute } from "../../../common/unwrapGameAttribute.ts";

const DEFAULT_ROSTER = "nhl-rosters/NHL_2026-2027_Opening_Rosters_v1.json";
const DEFAULT_NUM_SEASONS = 10;

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

const fmt = (x: number, d = 1) => x.toFixed(d);
const pad = (x: string | number, w: number) => String(x).padStart(w);
const quantile = (sorted: number[], q: number) =>
	sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
const mean = (a: number[]) =>
	a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
const sd = (a: number[]) => {
	const m = mean(a);
	return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

test("real pipeline: multi-season franchise from the roster", async () => {
	const fsSpecifier = "node:fs";
	const fs: any = await import(fsSpecifier);
	const env = (globalThis as any).process?.env ?? {};
	const ROSTER = env.NHL_ROSTER ?? DEFAULT_ROSTER;
	const NUM_SEASONS = Number(env.NHL_SEASONS) || DEFAULT_NUM_SEASONS;
	const RANDOM = env.NHL_RANDOM === "1";
	if (!fs.existsSync(ROSTER)) {
		console.log(
			`roster file not found (${ROSTER}); skipping real-pipeline test`,
		);
		return;
	}

	const origRandom = Math.random;
	Math.random = mulberry32(20262046);

	try {
		const data = JSON.parse(fs.readFileSync(ROSTER, "utf8"));
		const ga = data.gameAttributes;
		const maxRosterPid = RANDOM
			? -1
			: Math.max(...data.players.map((p: any) => p.pid));

		// Same derivation as the New League screen: file settings over the sport defaults
		const settings: any = helpers.deepCopy(getDefaultSettings());
		for (const key of Object.keys(settings)) {
			if (
				[
					"noStartingInjuries",
					"randomization",
					"realStats",
					"giveMeWorstRoster",
				].includes(key)
			) {
				continue;
			}
			const v = unwrapGameAttribute(ga, key as any);
			if (v !== undefined) {
				settings[key] = key === "repeatSeason" ? (v as any)?.type : v;
			}
		}

		const leagueObject = RANDOM
			? {
					version: data.version,
					startingSeason: data.startingSeason,
					gameAttributes: ga,
					teams: data.teams,
				}
			: data;
		const keptKeys = new Set(
			RANDOM
				? ["gameAttributes", "teams", "startingSeason", "version"]
				: ["gameAttributes", "teams", "players", "startingSeason", "version"],
		);
		const teams = helpers.addPopRank(helpers.deepCopy(data.teams));

		const t0 = Date.now();
		await league.createStream(createStreamFromLeagueObject(leagueObject), {
			conditions: {},
			confs: unwrapGameAttribute(ga, "confs"),
			divs: unwrapGameAttribute(ga, "divs"),
			fromFile: {
				gameAttributes: ga,
				hasRookieContracts: RANDOM
					? true
					: data.players.some((p: any) => p.contract?.rookie),
				maxGid: undefined,
				startingSeason: data.startingSeason,
				teams: data.teams,
				version: data.version,
			},
			getLeagueOptions: undefined,
			keptKeys: keptKeys as any,
			lid: 0,
			name: "Harness",
			setLeagueCreationStatus: () => {},
			settings,
			shuffleRosters: false,
			startingSeasonFromInput: undefined,
			teamsFromInput: teams as any,
			tid: 0,
		} as any);
		// The app does this when it opens a league; it fills the attributes the file doesn't carry
		await league.loadGameAttributes();

		const start = g.get("season");
		const target = start + NUM_SEASONS;
		console.log(
			`${RANDOM ? "random players" : "roster"} league created in ${Date.now() - t0} ms: ${g.get("numTeams")} teams, farm ${g.get("farmSystem")}, ${g.get("numDraftRounds")} draft rounds, cap ${g.get("salaryCap")}, roster ${g.get("minRosterSize")}-${g.get("maxRosterSize")}, maxContracts ${g.get("maxContracts")}`,
		);

		// The user team is AI-managed while autoPlayUntil is set
		local.autoPlayUntil = { season: target, phase: 0, start: Date.now() };
		league
			.autoPlay()
			.catch((e: any) => console.log("autoPlay error:", e?.stack ?? e));
		await new Promise<void>((resolve, reject) => {
			let lastSeason = start;
			let lastChange = Date.now();
			const id = setInterval(() => {
				const season = g.get("season");
				if (season !== lastSeason) {
					console.log(
						`season ${lastSeason} done at t+${fmt((Date.now() - t0) / 1000, 0)}s`,
					);
					lastSeason = season;
					lastChange = Date.now();
				}
				if (season === target && g.get("phase") === 0) {
					clearInterval(id);
					setTimeout(resolve, 2000);
				} else if (Date.now() - lastChange > 300_000) {
					clearInterval(id);
					reject(
						new Error(
							`auto play stalled in season ${season} phase ${g.get("phase")}`,
						),
					);
				}
			}, 500);
		});
		await idb.cache.flush();

		// ---------- Collect from the league DB ----------
		const teamSeasons: any[] = await idb.league.getAll("teamSeasons");
		const teamStats: any[] = await idb.league.getAll("teamStats");
		const players: any[] = await idb.league.getAll("players");

		const rows: string[] = [];
		rows.push(
			"Yr    G/g  SOG  Sh%   SV%   PP%  PIM  Hit  Blk  OT%  | mOvr p10 p50 p90 top5 | D%  real% | Top-Bot  SD ≥110 ≤60 | TopPts  bSV%",
		);
		for (let season = start; season < target; season++) {
			const ts = teamSeasons.filter((t) => t.season === season);
			const pts = ts
				.map((t) => 2 * t.won + t.otl + t.tied)
				.toSorted((a, b) => b - a);
			const gpTeams = ts.reduce(
				(s, t) => s + t.won + t.lost + t.otl + t.tied,
				0,
			);
			const otPct = (100 * ts.reduce((s, t) => s + t.otl, 0)) / (gpTeams / 2);

			const st = teamStats.filter((t) => t.season === season && !t.playoffs);
			const sum = (k: string) => st.reduce((s, t) => s + (t[k] ?? 0), 0);
			const gp = sum("gp");
			const goals = sum("evG") + sum("ppG") + sum("shG");
			const sog = sum("s");
			const savePct = sum("sv") / (sum("sv") + goals);

			const rostered: { ovr: number; pos: string; real: boolean }[] = [];
			let topPts = 0;
			let bestSv = 0;
			for (const p of players) {
				const r = p.ratings.find((x: any) => x.season === season);
				if (!r) {
					continue;
				}
				const sts = p.stats.filter(
					(x: any) => x.season === season && !x.playoffs && x.tid >= 0,
				);
				const gpP = sts.reduce((s: number, x: any) => s + x.gp, 0);
				if (gpP < 10) {
					continue;
				}
				rostered.push({ ovr: r.ovr, pos: r.pos, real: p.pid <= maxRosterPid });
				const ptsP = sts.reduce(
					(s: number, x: any) =>
						s + x.evG + x.ppG + x.shG + x.evA + x.ppA + x.shA,
					0,
				);
				topPts = Math.max(topPts, ptsP);
				const gpG = sts.reduce((s: number, x: any) => s + x.gpGoalie, 0);
				if (gpG >= 25) {
					const sv = sts.reduce((s: number, x: any) => s + x.sv, 0);
					const ga = sts.reduce((s: number, x: any) => s + x.ga, 0);
					bestSv = Math.max(bestSv, sv / (sv + ga));
				}
			}
			const ovrs = rostered.map((p) => p.ovr).toSorted((a, b) => a - b);
			const top5 = ovrs.slice(-Math.max(1, Math.round(ovrs.length * 0.05)));
			const skaters = rostered.filter((p) => p.pos !== "G");
			const dShare =
				(100 * skaters.filter((p) => p.pos === "D").length) / skaters.length;
			const realShare =
				(100 * rostered.filter((p) => p.real).length) / rostered.length;

			rows.push(
				`${season}  ${fmt(goals / gp, 2)} ${fmt(sog / gp)} ${fmt((100 * goals) / sog)}  ${fmt(savePct, 3)} ${fmt((100 * sum("ppG")) / sum("ppo"))} ${fmt(sum("pim") / gp)} ${fmt(sum("hit") / gp)} ${fmt(sum("blk") / gp)} ${fmt(otPct)} | ${fmt(mean(ovrs))} ${pad(quantile(ovrs, 0.1), 3)} ${pad(quantile(ovrs, 0.5), 3)} ${pad(quantile(ovrs, 0.9), 3)} ${fmt(mean(top5))} | ${pad(fmt(dShare, 0), 2)}  ${pad(fmt(realShare, 0), 3)}  | ${pad(pts[0]!, 3)}-${pad(pts.at(-1)!, 3)} ${pad(fmt(sd(pts)), 4)} ${pad(pts.filter((x) => x >= 110).length, 3)} ${pad(pts.filter((x) => x <= 60).length, 3)} | ${pad(topPts, 4)}   ${fmt(bestSv, 3)}`,
			);
		}
		console.log(
			`\n${rows.join("\n")}\n(rostered = NHL gp >= 10 that season; real% = players from the roster file; ${fmt((Date.now() - t0) / 1000, 0)} s total)`,
		);

		assert.strictEqual(
			g.get("season"),
			target,
			"did not reach the target season",
		);
	} finally {
		Math.random = origRandom;
		local.autoPlayUntil = undefined;
	}
}, 3_600_000);
