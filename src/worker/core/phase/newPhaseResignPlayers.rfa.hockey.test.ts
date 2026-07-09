import { assert, beforeAll, test } from "vitest";
import { PHASE, PLAYER } from "../../../common/constants.ts";
import { DEFAULT_LEVEL } from "../../../common/budgetLevels.ts";
import { g, helpers } from "../../util/index.ts";
import { idb } from "../../db/index.ts";
import { resetCache, resetG } from "../../../test/helpers.ts";
import { freeAgents, player, team } from "../index.ts";
import newPhaseResignPlayers from "./newPhaseResignPlayers.ts";

// 2 C, 4 W, 3 D, 2 G - same layout as the ValueChangeCalculator tests
const POSITIONS_LAYOUT = [
	"C",
	"C",
	"W",
	"W",
	"W",
	"W",
	"D",
	"D",
	"D",
	"G",
	"G",
];

const genRoster = (tid: number, age: number, ovr: number) =>
	POSITIONS_LAYOUT.map((pos) => {
		const p = player.generate(tid, age, 2010, true, DEFAULT_LEVEL);
		const ratings = p.ratings[0]!;
		ratings.pos = pos;
		ratings.ovr = ovr;
		ratings.pot = ovr;
		(ratings as any).ovrs = { C: ovr, W: ovr, D: ovr, G: ovr };
		(ratings as any).pots = { C: ovr, W: ovr, D: ovr, G: ovr };
		p.value = ovr;
		p.valueNoPot = ovr;
		p.valueFuzz = ovr;
		p.valueNoPotFuzz = ovr;
		p.contract.amount = 2000;

		// Not expiring - only the star tests the RFA path
		p.contract.exp = g.get("season") + 2;

		return p;
	});

let starPid: number;

beforeAll(async () => {
	resetG();
	g.setWithoutSavingToDB("season", 2028);
	g.setWithoutSavingToDB("phase", PHASE.RESIGN_PLAYERS);
	g.setWithoutSavingToDB("numTeams", 4);
	g.setWithoutSavingToDB("numActiveTeams", 4);

	// The user controls team 3, so teams 0-2 take the AI path
	g.setWithoutSavingToDB("userTid", 3);
	g.setWithoutSavingToDB("userTids", [3]);

	// Skip the future-draft-class generation at the end of the phase, which needs a real IndexedDB
	g.setWithoutSavingToDB("repeatSeason", {
		type: "players",
		startingSeason: 2028,
	});

	const teamsDefault = helpers.getTeamsDefault().slice(0, 4);
	g.setWithoutSavingToDB(
		"teamInfoCache",
		teamsDefault.map((t) => ({
			abbrev: t.abbrev,
			region: t.region,
			name: t.name,
			imgURL: undefined,
			imgURLSmall: undefined,
			disabled: false,
		})),
	);

	// The Michkov case: a 23 year old star winger coming off his rookie deal
	const star = player.generate(0, 23, 2025, true, DEFAULT_LEVEL);
	const ratings = star.ratings[0]!;
	ratings.pos = "W";
	ratings.ovr = 75;
	ratings.pot = 80;
	(ratings as any).ovrs = { C: 75, W: 75, D: 75, G: 75 };
	(ratings as any).pots = { C: 80, W: 80, D: 80, G: 80 };
	star.born.year = g.get("season") - 23;
	star.value = 75;
	star.valueNoPot = 75;
	star.valueFuzz = 75;
	star.valueNoPotFuzz = 75;
	star.contract.amount = 950;
	star.contract.exp = g.get("season");
	star.stats = [1, 2, 3].map((i) => ({
		season: g.get("season") - i,
		gp: 80,
		playoffs: false,
		min: 1500,
	})) as any;

	await resetCache({
		players: [
			star,
			...genRoster(0, 27, 60),
			...genRoster(1, 26, 60),
			...genRoster(2, 25, 60),
			...genRoster(3, 28, 60),
		],
		teams: teamsDefault.map((t) => team.generate(t)),
	});

	starPid = star.pid!;
});

test("a young star coming off his rookie contract is tendered, and only his team can sign him", async () => {
	await newPhaseResignPlayers({});

	const star = await idb.cache.players.get(starPid);
	assert(star);

	// Tendered: in the free agent pool, rights held by team 0
	assert.strictEqual(star.tid, PLAYER.FREE_AGENT);
	assert.strictEqual(star.rfaTid, 0);

	// 30 days of free agency: nobody but team 0 may sign him
	g.setWithoutSavingToDB("phase", PHASE.FREE_AGENCY);
	for (let day = 0; day < 30; day++) {
		await freeAgents.autoSign();

		const p = await idb.cache.players.get(starPid);
		assert(p);
		assert(
			p.tid === PLAYER.FREE_AGENT || p.tid === 0,
			`star ended up on team ${p.tid} on day ${day}`,
		);

		if (p.tid === 0) {
			// Re-signed by his rights team, and the rights flag is gone
			assert.strictEqual(p.rfaTid, undefined);
			return;
		}
	}

	// Probability of 30 straight failed 15% re-sign rolls is ~0.8%, and even then the rights must be intact
	const p = await idb.cache.players.get(starPid);
	assert.strictEqual(p!.rfaTid, 0);
});

test("an RFA at an already-covered position is not tendered, just released to UFA", async () => {
	resetG();
	g.setWithoutSavingToDB("season", 2028);
	g.setWithoutSavingToDB("phase", PHASE.RESIGN_PLAYERS);
	g.setWithoutSavingToDB("numTeams", 4);
	g.setWithoutSavingToDB("numActiveTeams", 4);
	g.setWithoutSavingToDB("userTid", 3);
	g.setWithoutSavingToDB("userTids", [3]);
	g.setWithoutSavingToDB("repeatSeason", {
		type: "players",
		startingSeason: 2028,
	});

	const teamsDefault = helpers.getTeamsDefault().slice(0, 4);
	g.setWithoutSavingToDB(
		"teamInfoCache",
		teamsDefault.map((t) => ({
			abbrev: t.abbrev,
			region: t.region,
			name: t.name,
			imgURL: undefined,
			imgURLSmall: undefined,
			disabled: false,
		})),
	);

	// Team 0 already has a deep, higher-value wing corps signed - this young
	// winger is surplus at his position (positionInfo W count <= 0, maxValue 60 > 50)
	const surplus = player.generate(0, 23, 2025, true, DEFAULT_LEVEL);
	const sr = surplus.ratings[0]!;
	sr.pos = "W";
	sr.ovr = 50;
	sr.pot = 50;
	(sr as any).ovrs = { C: 50, W: 50, D: 50, G: 50 };
	(sr as any).pots = { C: 50, W: 50, D: 50, G: 50 };
	surplus.born.year = g.get("season") - 23;
	surplus.value = 50;
	surplus.valueNoPot = 50;
	surplus.valueFuzz = 50;
	surplus.valueNoPotFuzz = 50;
	surplus.contract.amount = 4000;
	surplus.contract.exp = g.get("season");
	surplus.stats = [1, 2, 3].map((i) => ({
		season: g.get("season") - i,
		gp: 80,
		playoffs: false,
		min: 1500,
	})) as any;

	// 11 incumbent wings (more than POSITION_COUNTS W=10), all higher value and not expiring
	const incumbents = Array.from({ length: 11 }, () => {
		const p = player.generate(0, 27, 2010, true, DEFAULT_LEVEL);
		const ratings = p.ratings[0]!;
		ratings.pos = "W";
		ratings.ovr = 60;
		ratings.pot = 60;
		(ratings as any).ovrs = { C: 60, W: 60, D: 60, G: 60 };
		(ratings as any).pots = { C: 60, W: 60, D: 60, G: 60 };
		p.value = 60;
		p.valueNoPot = 60;
		p.valueFuzz = 60;
		p.valueNoPotFuzz = 60;
		p.contract.amount = 2000;
		p.contract.exp = g.get("season") + 2;
		return p;
	});

	await resetCache({
		players: [surplus, ...incumbents],
		teams: teamsDefault.map((t) => team.generate(t)),
	});

	const surplusPid = surplus.pid!;

	await newPhaseResignPlayers({});

	const p = await idb.cache.players.get(surplusPid);
	assert(p);
	// Released to free agency, but NOT tendered - no exclusive rights
	assert.strictEqual(p.tid, PLAYER.FREE_AGENT);
	assert.strictEqual(p.rfaTid, undefined);
});
