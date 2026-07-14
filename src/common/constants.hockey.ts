import type { CompositeWeights, Conf, Div, NonEmptyArray } from "./types.ts";
import type { Position, RatingKey } from "./types.hockey.ts";

export const COMPOSITE_WEIGHTS: CompositeWeights<RatingKey> = {
	playmaker: {
		ratings: ["stk", "pss", "oiq", "spd", "hgt", "stre"],
		weights: [1, 1, 1, 1, 0.25, 0.1],
		skill: {
			label: "Pm",
			cutoff: 0.57,
		},
	},
	power: {
		ratings: ["stk", "stre", "chk", "hgt", "spd"],
		weights: [1, 1, 1, 0.25, 0.1],
		skill: {
			label: "Pw",
			cutoff: 0.47,
		},
	},
	grinder: {
		ratings: ["blk", "chk", "diq", "hgt", "stre", "spd"],
		weights: [1, 1, 1, 0.25, 0.25, 0.1],
		skill: {
			label: "G",
			cutoff: 0.65,
		},
	},
	enforcer: {
		ratings: ["stre", "chk", "hgt", "spd"],
		weights: [1, 1, 0.25, 0.1],
		skill: {
			label: "E",
			cutoff: 0.61,
		},
	},
	sniper: {
		ratings: ["sst", "wst", "oiq"],
		weights: [1, 1, 0.25],
		skill: {
			label: "S",
			cutoff: 0.68,
		},
	},
	faceoffs: {
		ratings: ["fcf"],
	},
	goalkeeping: {
		ratings: ["glk"],
	},
	blocking: {
		ratings: ["blk", "diq", "stre", "spd"],
		weights: [1, 1, 0.1, 0.1],
	},
	scoring: {
		ratings: ["sst", "wst", "stk", "oiq", "spd", "hgt", "stre"],
		weights: [1, 1, 0.5, 1, 1, 0.25, 0.1],
	},
	penalties: {
		// Who takes a penalty. Lower flat baseline + heavier checking, with both defensive
		// IQ (discipline) and offensive IQ (skilled players draw penalties more than they
		// take them) reducing it, so enforcers take far more than disciplined stars.
		ratings: [40, "chk", "diq", "oiq"],
		weights: [1, 1.2, -0.4, -0.4],
	},
	endurance: {
		ratings: [50, "endu"],
		weights: [1, 1],
	},
};

export const PLAYER_GAME_STATS = {
	skaters: {
		name: "Skater",
		stats: [
			"g",
			"a",
			"pts",
			"pm",
			"pim",
			"s",
			"sPct",
			"hit",
			"blk",
			"gv",
			"tk",
			"fow",
			"fol",
			"foPct",
			"shft",
			"min",
			"ppMin",
			"shMin",
		],
		sortBy: ["min"],
	},
	goalies: {
		name: "Goalie",
		stats: ["ga", "sa", "sv", "svPct", "pim", "min", "ppMin", "shMin"],
		sortBy: ["min"],
	},
};

export const PLAYER_SUMMARY = {
	summarySkater: {
		name: "SummarySkater",
		onlyShowIf: ["C", "W", "D"],
		stats: ["gpSkater", "g", "a", "pts", "pm", "ops", "dps", "ps"],
	},
	summaryGoalie: {
		name: "SummaryGoalie",
		onlyShowIf: ["G"],
		stats: ["gpGoalie", "gRec", "so", "gaa", "svPct", "gps"],
	},
};

export const PLAYER_STATS_TABLES = {
	goalie: {
		name: "Goalie",
		stats: [
			"gpGoalie",
			"gRec",
			"ga",
			"sa",
			"sv",
			"svPct",
			"gaa",
			"so",
			"min",
			"ppMin",
			"shMin",
			"pim",
		],
		onlyShowIf: ["sv"],
	},
	skater: {
		name: "Skater",
		stats: [
			"gpSkater",
			"g",
			"a",
			"pts",
			"pm",
			"pim",
			"evG",
			"ppG",
			"shG",
			"gwG",
			"evA",
			"ppA",
			"shA",
			"gwA",
			"s",
			"sPct",
			"tsa",
			"shft",
			"min",
			"ppMin",
			"shMin",
			"amin",
			"fow",
			"fol",
			"foPct",
			"blk",
			"hit",
			"tk",
			"gv",
		],
		onlyShowIf: ["pts", "tsa", "fow", "fol", "blk", "hit", "tk", "gv"],
	},
	advanced: {
		name: "Advanced",
		stats: [
			"gp",
			"gc",
			"ops",
			"dps",
			"gps",
			"ps",
			"g60",
			"a60",
			"pts60",
			"s60",
			"evG60",
			"ppG60",
			"shG60",
			"evA60",
			"ppA60",
			"shA60",
			"evPts60",
			"ppPts60",
			"shPts60",
		],
	},
	gameHighs: {
		name: "Game Highs",
		stats: [
			"gp",
			"gMax",
			"aMax",
			"ptsMax",
			"pmMax",
			"pimMax",
			"evGMax",
			"ppGMax",
			"shGMax",
			"evAMax",
			"ppAMax",
			"shAMax",
			"sMax",
			"tsaMax",
			"shftMax",
			"minMax",
			"ppMinMax",
			"shMinMax",
			"fowMax",
			"folMax",
			"blkMax",
			"hitMax",
			"tkMax",
			"gvMax",
			"gaMax",
			"svMax",
		],
	},
};

export const TEAM_STATS_TABLES = {
	team: {
		name: "Team",
		stats: [
			"g",
			"a",
			"pim",
			"evG",
			"ppG",
			"shG",
			"evA",
			"ppA",
			"shA",
			"s",
			"sPct",
			"tsa",
			"ppo",
			"ppPct",
			"fow",
			"fol",
			"foPct",
			"blk",
			"hit",
			"tk",
			"gv",
			"sv",
			"svPct",
			"gaa",
			"so",
			"mov",
		],
	},
	opponent: {
		name: "Opponent",
		stats: [
			"oppG",
			"oppA",
			"oppPim",
			"oppEvG",
			"oppPpG",
			"oppShG",
			"oppEvA",
			"oppPpA",
			"oppShA",
			"oppS",
			"oppSPct",
			"oppTsa",
			"oppPpo",
			"oppPpPct",
			"oppFow",
			"oppFol",
			"oppFoPct",
			"oppBlk",
			"oppHit",
			"oppTk",
			"oppGv",
			"oppSv",
			"oppSvPct",
			"oppGaa",
			"oppSo",
			"oppMov",
		],
	},
};

export const POSITIONS: Position[] = ["C", "W", "D", "G"];

export const POSITION_COUNTS: Record<Position, number> = {
	C: 5,
	W: 10,
	D: 7,
	G: 3,
};

export const RATINGS: RatingKey[] = [
	"hgt",
	"stre",
	"spd",
	"endu",
	"pss",
	"wst",
	"sst",
	"stk",
	"oiq",
	"chk",
	"blk",
	"fcf",
	"diq",
	"glk",
];

export const SIMPLE_AWARDS = [
	"mvp",
	"dpoy",
	"dfoy",
	"goy",
	"roy",
	"finalsMvp",
] as const;

export const AWARD_NAMES = {
	mvp: "Hart Memorial Trophy",
	roy: "Calder Memorial Trophy",
	dpoy: "Norris Trophy",
	dfoy: "Selke Trophy",
	goy: "Vezina Trophy",
	finalsMvp: "Conn Smythe Trophy",
	allLeague: "All-League",
	allRookie: "All-Rookie Team",
} as const;

export const DEFAULT_CONFS: NonEmptyArray<Conf> = [
	{
		cid: 0,
		name: "Eastern Conference",
	},
	{
		cid: 1,
		name: "Western Conference",
	},
];

export const DEFAULT_DIVS: NonEmptyArray<Div> = [
	{
		did: 0,
		cid: 0,
		name: "Atlantic",
	},
	{
		did: 1,
		cid: 0,
		name: "Metropolitan",
	},
	{
		did: 2,
		cid: 1,
		name: "Central",
	},
	{
		did: 3,
		cid: 1,
		name: "Pacific",
	},
];

export const NUM_LINES = {
	F: 4,
	D: 3,
	G: 1,
};

export const NUM_PLAYERS_PER_LINE = {
	F: 3,
	D: 2,
	G: 1,
};

// Farm system ("club-école"): buried-contract cap relief, like the NHL's ~$1.15M relief for players in the minors [thousands of dollars]
export const FARM_CAP_RELIEF = 1150;

// Farm system: AI active-roster targets by dressing group (12F/6D/1G dress, plus spares), C/W collapse into F because dressing operates on forward lines
export const FARM_ACTIVE_TARGETS = {
	F: 13,
	D: 7,
	G: 2,
};

// Farm system: simplified waiver exemption — a player can be sent down iff age <= FARM_ELIGIBLE_MAX_AGE or career regular-season NHL games < FARM_ELIGIBLE_MAX_CAREER_GP
export const FARM_ELIGIBLE_MAX_AGE = 25;
export const FARM_ELIGIBLE_MAX_CAREER_GP = 160;

// Farm system: AI only promotes a farm player over an active one when his value exceeds the active's by this margin (prevents call-up/send-down oscillation)
export const FARM_PROMOTE_MARGIN = 6;

// Farm system: abstract AHL stat generation (cosmetic, ratings-derived). A farm player "plays" on days his parent club plays, so expected AHL games scale with numGames.
export const FARM_STATS_GAME_PROB = 0.85; // skaters: ~70 AHL games over an 82-game parent season
export const FARM_STATS_GOALIE_GAME_PROB = 0.425; // goalies split an AHL tandem: ~35 starts
export const FARM_STATS_PPG_BASE = 0.25; // expected AHL points per game at ovr 30
export const FARM_STATS_PPG_SLOPE = 0.03; // per ovr point above 30 (ovr 55 ≈ 1.0 ppg, an AHL first-liner)
export const FARM_STATS_PPG_MIN = 0.15;
export const FARM_STATS_PPG_MAX = 1.5;
export const FARM_STATS_D_FACTOR = 0.55; // defensemen score less
export const FARM_STATS_GOAL_SHARE_F = 0.4; // goals vs assists split
export const FARM_STATS_GOAL_SHARE_D = 0.3;
// Save percentage curve pinned to this fork's de-saturated glk scale (farm goalies run glk ~30-70) so the AHL league lands around .895-.905
export const FARM_STATS_SV_BASE = 0.87; // at glk 40
export const FARM_STATS_SV_SLOPE = 0.0012; // per glk point above 40
export const FARM_STATS_SV_MIN = 0.875;
export const FARM_STATS_SV_MAX = 0.935;
export const FARM_STATS_SHOTS_MIN = 22;
export const FARM_STATS_SHOTS_MAX = 34;
