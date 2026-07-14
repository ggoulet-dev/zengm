import { g } from "../../util/index.ts";
import { last } from "../../../common/utils.ts";
import { farmEnabled, isOnFarm } from "../team/farm.hockey.ts";
import {
	FARM_DEV_BENCH_AMIN,
	FARM_DEV_BENCH_ROT,
	FARM_DEV_GOALIE_ROT_GP_FRAC,
	FARM_DEV_INJURY_EXCUSE_FRAC,
	FARM_DEV_NHL_ROLE_FRAC,
	FARM_DEV_PARTICIPATION_FRAC,
	FARM_DEV_STAGNATION,
	FARM_DEV_STAGNATION_MILD,
} from "../../../common/constants.hockey.ts";
import type { Player } from "../../../common/types.ts";

type PlayerLean = Pick<
	Player,
	"born" | "farm" | "farmStats" | "injuries" | "ratings" | "stats"
>;

/**
 * Usage-conditioned development, penalties only: the multiplier applied to the
 * POSITIVE development component based on where and how much a player played
 * last season. Correct usage — an NHL regular, or a prospect getting big AHL
 * minutes — is always 1. The penalties:
 *
 * - Bench rot: a young player kept in the NHL without really playing
 *   (pressbox/scratches, or a full-time sub-10-minute role) develops worse
 *   than he would have playing top minutes in the minors.
 * - AHL stagnation: an older player buried in the minors stops developing.
 *
 * The young windows mirror the positive development tails in
 * developSeason.hockey.ts (skaters through 23, goalies through 25 — goalies
 * develop later, and NHL backup workloads are normal usage for them).
 *
 * Called only from the annual preseason develop, where p.stats holds last
 * season's rows, p.farmStats holds the abstract AHL games, and p.farm is the
 * end-of-last-season assignment. Every other develop call site passes no
 * modifier and stays bit-identical to the pre-feature behavior. No RNG.
 */
const getUsageDevModifier = (p: PlayerLean): number => {
	if (!farmEnabled()) {
		return 1;
	}

	// The preseason already bumped the season, so "last season" is season - 1 and this age matches the age develop() uses
	const season = g.get("season");
	const lastSeason = season - 1;
	const numGames = g.get("numGames");
	const age = season - p.born.year;

	const isGoalie = last(p.ratings).pos === "G";

	let nhlGp = 0;
	let totalMin = 0;
	for (const row of p.stats) {
		if (row.season === lastSeason && !row.playoffs) {
			nhlGp += (isGoalie ? row.gpGoalie : row.gp) ?? 0;
			totalMin += row.min ?? 0;
		}
	}

	const farmGp = p.farmStats?.find((row) => row.season === lastSeason)?.gp ?? 0;
	const onFarm = isOnFarm(p);

	// Injuries (and suspensions, stored the same way — slightly lenient) excuse missed games
	let injuredGames = 0;
	for (const row of p.injuries) {
		if (row.season === lastSeason) {
			injuredGames += row.games;
		}
	}
	const availableGames = Math.max(
		numGames - Math.min(injuredGames, numGames),
		1,
	);

	// Season lost to injury: never penalize
	if (availableGames < FARM_DEV_INJURY_EXCUSE_FRAC * numGames) {
		return 1;
	}

	const nhlRole = nhlGp / availableGames >= FARM_DEV_NHL_ROLE_FRAC;

	if (isGoalie) {
		if (age <= 25) {
			if (onFarm || nhlGp + farmGp === 0) {
				// AHL starts are development; zero data (free agent all year, just imported) is never penalized
				return 1;
			}
			if (nhlGp + farmGp < FARM_DEV_GOALIE_ROT_GP_FRAC * availableGames) {
				return FARM_DEV_BENCH_ROT;
			}
			return 1;
		}

		if (onFarm && !nhlRole) {
			return age === 26 ? FARM_DEV_STAGNATION_MILD : FARM_DEV_STAGNATION;
		}
		return 1;
	}

	// Skaters
	if (age <= 23) {
		if (onFarm || nhlGp === 0) {
			return 1;
		}

		// A mid-season call-up's AHL games count as playing
		if ((nhlGp + farmGp) / availableGames < FARM_DEV_PARTICIPATION_FRAC) {
			return FARM_DEV_BENCH_ROT;
		}

		// Dressing every night for 8 minutes is still rot
		const amin = totalMin / nhlGp;
		if (nhlRole && farmGp === 0 && amin < FARM_DEV_BENCH_AMIN) {
			return FARM_DEV_BENCH_ROT;
		}

		return 1;
	}

	if (onFarm && !nhlRole) {
		return age === 24 ? FARM_DEV_STAGNATION_MILD : FARM_DEV_STAGNATION;
	}

	return 1;
};

export default getUsageDevModifier;
