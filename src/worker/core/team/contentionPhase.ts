import { idb } from "../../db/index.ts";
import { g, helpers, local } from "../../util/index.ts";
import { last } from "../../../common/utils.ts";
import type { Player } from "../../../common/types.ts";

// NHL-style team lifecycle, refining the binary contending/rebuilding strategy for trade AI purposes (hockey only):
// - teardown: bad team with an aging core - sell every veteran with value for picks/prospects
// - accumulation: bad team with a young core - keep stacking futures, no rush
// - emergence: young core arriving, team becoming competitive - start converting surplus futures into established players
// - push: good team entering its window - pay up for impact players, picks start losing appeal
// - winNow: contender with the window open - all-in, overpay for current production
export type ContentionPhase =
	| "teardown"
	| "accumulation"
	| "emergence"
	| "push"
	| "winNow";

export const classifyContentionPhase = ({
	strengthPct,
	coreAge,
	pipeline,
	dWon,
}: {
	// Percentile of estimated team strength, 0 (worst) to 1 (best)
	strengthPct: number;

	// Mean age of the top players by value (the core)
	coreAge: number;

	// Futures on hand: high-potential young players and owned early draft picks, see ValueChangeCalculator
	pipeline: number;

	// Change in wins vs last season, 0 if unknown
	dWon: number;
}): ContentionPhase => {
	// Trajectory nudges perceived strength: a collapsing team should sell earlier, a surging team buys earlier
	const strength = helpers.bound(
		strengthPct + 0.1 * Math.tanh(dWon / 15),
		0,
		1,
	);

	if (strength >= 0.65) {
		return coreAge <= 27.5 ? "push" : "winNow";
	}

	if (strength <= 0.35) {
		// Old core, or young but with nothing in the pipeline - sell veterans to build one
		if (coreAge >= 27.5 || pipeline < 1) {
			return "teardown";
		}

		return "accumulation";
	}

	// Mushy middle - split by where the core is in its lifecycle. Mediocre teams with a prime-age core act like buyers (the classic GM "we're close" bias), old ones should tear down.
	if (coreAge >= 28.5) {
		return "teardown";
	}

	if (coreAge >= 27) {
		return "push";
	}

	return "emergence";
};

type PhaseFactors = {
	// Multiplier for future draft picks (and the pick-like uncertainty of prospects is handled via the age table)
	pick: number;

	// [maxAge, multiplier] pairs, first matching maxAge wins; last entry is the fallback for older players
	ages: [number, number][];

	// How much contract surplus/deadweight matters, replaces the binary 2/0.5 from sumValues
	contracts: number;
};

const PHASE_FACTORS: Record<ContentionPhase, PhaseFactors> = {
	teardown: {
		pick: 1.25,
		ages: [
			[21, 1.15],
			[23, 1.1],
			[26, 1],
			[28, 0.9],
			[Infinity, 0.8],
		],
		contracts: 2,
	},
	accumulation: {
		pick: 1.15,
		ages: [
			[21, 1.1],
			[23, 1.075],
			[26, 1],
			[28, 0.95],
			[Infinity, 0.85],
		],
		contracts: 2,
	},
	emergence: {
		pick: 1,
		ages: [
			[21, 1],
			[23, 1.025],
			[27, 1.05],
			[29, 0.975],
			[Infinity, 0.95],
		],
		contracts: 1,
	},
	push: {
		pick: 0.85,
		ages: [
			[21, 0.9],
			[23, 0.95],
			[29, 1.05],
			[32, 1],
			[Infinity, 0.95],
		],
		contracts: 0.75,
	},
	winNow: {
		pick: 0.7,
		ages: [
			[21, 0.8],
			[23, 0.9],
			[32, 1.1],
			[Infinity, 1],
		],
		contracts: 0.5,
	},
};

export const getPhaseAssetMultiplier = (
	phase: ContentionPhase,
	asset: { age: number; treatAsFutureDraftPick: boolean },
): number => {
	const factors = PHASE_FACTORS[phase];

	if (asset.treatAsFutureDraftPick) {
		return factors.pick;
	}

	for (const [maxAge, factor] of factors.ages) {
		if (asset.age <= maxAge) {
			return factor;
		}
	}

	// Unreachable, the last entry is Infinity
	return 1;
};

export const getPhaseContractsFactor = (phase: ContentionPhase): number =>
	PHASE_FACTORS[phase].contracts;

// Compute the contention phase of every team, from data the ValueChangeCalculator already has on hand. wps must be sorted ascending by wp, like getEstPicks returns it.
export const computeContentionPhases = async (
	playersByTid: Map<number, Player[]>,
	wps: { tid: number; wp: number }[],
): Promise<Record<number, ContentionPhase>> => {
	const season = g.get("season");
	const numGames = g.get("numGames");

	// Early draft picks owned over the next couple drafts
	const pipelineFromPicks = new Map<number, number>();
	for (const dp of await idb.cache.draftPicks.getAll()) {
		if (typeof dp.season !== "number" || dp.season > season + 2) {
			continue;
		}

		if (dp.round === 1) {
			pipelineFromPicks.set(dp.tid, (pipelineFromPicks.get(dp.tid) ?? 0) + 1);
		} else if (dp.round === 2) {
			pipelineFromPicks.set(dp.tid, (pipelineFromPicks.get(dp.tid) ?? 0) + 0.4);
		}
	}

	const phases: Record<number, ContentionPhase> = {};

	for (const [tid, players] of playersByTid) {
		// Core age: mean age of the top players by value
		const top = players.toSorted((a, b) => b.value - a.value).slice(0, 10);
		const coreAge =
			top.length > 0
				? top.reduce((sum, p) => sum + (season - p.born.year), 0) / top.length
				: 26;

		// Pipeline: owned early picks plus young high-potential players
		let pipeline = pipelineFromPicks.get(tid) ?? 0;
		if (local.playerOvrStd > 0) {
			for (const p of players) {
				const age = season - p.born.year;
				const potZ =
					(last(p.ratings).pot - local.playerOvrMean) / local.playerOvrStd;
				if (age <= 23 && potZ >= 0.5) {
					pipeline += 0.75;
				}
			}
		}

		const wpIndex = wps.findIndex((w) => w.tid === tid);
		const strengthPct =
			wpIndex < 0 || wps.length <= 1 ? 0.5 : wpIndex / (wps.length - 1);

		// Trajectory: current estimated win pct (record blended with team ovr) vs last season's record
		let dWon = 0;
		if (wpIndex >= 0) {
			const lastTeamSeason = await idb.cache.teamSeasons.indexGet(
				"teamSeasonsBySeasonTid",
				[season - 1, tid],
			);
			if (lastTeamSeason) {
				// won + lost only, no otl/tied - getEstPicks computes wp with that same denominator, and mixing the two conventions would give every hockey team phantom wins
				const gpLast = lastTeamSeason.won + lastTeamSeason.lost;
				if (gpLast > 0) {
					dWon = (wps[wpIndex]!.wp - lastTeamSeason.won / gpLast) * numGames;
				}
			}
		}

		phases[tid] = classifyContentionPhase({
			strengthPct,
			coreAge,
			pipeline,
			dWon,
		});
	}

	return phases;
};
