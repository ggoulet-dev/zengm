import { g, helpers } from "../../util/index.ts";
import { randInt } from "../../../common/random.ts";
import { last } from "../../../common/utils.ts";
import type { PlayerWithoutKey } from "../../../common/types.ts";
import {
	FARM_STATS_D_FACTOR,
	FARM_STATS_GAME_PROB,
	FARM_STATS_GOAL_SHARE_D,
	FARM_STATS_GOAL_SHARE_F,
	FARM_STATS_GOALIE_GAME_PROB,
	FARM_STATS_PPG_BASE,
	FARM_STATS_PPG_MAX,
	FARM_STATS_PPG_MIN,
	FARM_STATS_PPG_SLOPE,
	FARM_STATS_SHOTS_MAX,
	FARM_STATS_SHOTS_MIN,
	FARM_STATS_SV_BASE,
	FARM_STATS_SV_MAX,
	FARM_STATS_SV_MIN,
	FARM_STATS_SV_SLOPE,
} from "../../../common/constants.hockey.ts";

// Knuth's Poisson sampler. Lambdas here are all < 3, so the loop runs a couple iterations.
const knuthPoisson = (lambda: number) => {
	const cutoff = Math.exp(-lambda);
	let k = 0;
	let product = 1;
	do {
		k += 1;
		product *= Math.random();
	} while (product > cutoff);
	return k - 1;
};

export const sampleFarmSkaterGame = (ovr: number, pos: string) => {
	let ppg = helpers.bound(
		FARM_STATS_PPG_BASE + (ovr - 30) * FARM_STATS_PPG_SLOPE,
		FARM_STATS_PPG_MIN,
		FARM_STATS_PPG_MAX,
	);
	if (pos === "D") {
		ppg *= FARM_STATS_D_FACTOR;
	}

	const goalShare =
		pos === "D" ? FARM_STATS_GOAL_SHARE_D : FARM_STATS_GOAL_SHARE_F;

	return {
		g: knuthPoisson(ppg * goalShare),
		a: knuthPoisson(ppg * (1 - goalShare)),
	};
};

export const sampleFarmGoalieGame = (glk: number) => {
	const pSave = helpers.bound(
		FARM_STATS_SV_BASE + (glk - 40) * FARM_STATS_SV_SLOPE,
		FARM_STATS_SV_MIN,
		FARM_STATS_SV_MAX,
	);
	const shots = randInt(FARM_STATS_SHOTS_MIN, FARM_STATS_SHOTS_MAX);
	const ga = Math.min(knuthPoisson(shots * (1 - pSave)), shots);

	return {
		sv: shots - ga,
		ga,
	};
};

// Roll one simulated day for a farm player whose parent club played. Returns
// true when the player accrued an AHL game (the caller persists the player).
export const accrueFarmGameDay = (p: PlayerWithoutKey): boolean => {
	const ratings = last(p.ratings);
	const isGoalie = ratings.pos === "G";

	const prob = isGoalie ? FARM_STATS_GOALIE_GAME_PROB : FARM_STATS_GAME_PROB;
	if (Math.random() >= prob) {
		return false;
	}

	const season = g.get("season");
	let row = p.farmStats?.find((r) => r.season === season);
	if (!row) {
		row = { season, gp: 0, g: 0, a: 0 };
		if (!p.farmStats) {
			p.farmStats = [];
		}
		p.farmStats.push(row);
	}

	row.gp += 1;
	if (isGoalie) {
		const { sv, ga } = sampleFarmGoalieGame((ratings as any).glk ?? 40);
		row.sv = (row.sv ?? 0) + sv;
		row.ga = (row.ga ?? 0) + ga;
	} else {
		const { g: goals, a } = sampleFarmSkaterGame(ratings.ovr, ratings.pos);
		row.g += goals;
		row.a += a;
	}

	return true;
};
