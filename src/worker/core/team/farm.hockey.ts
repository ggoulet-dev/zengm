import { isSport } from "../../../common/sportFunctions.ts";
import {
	FARM_CAP_RELIEF,
	FARM_ELIGIBLE_MAX_AGE,
	FARM_ELIGIBLE_MAX_CAREER_GP,
} from "../../../common/constants.hockey.ts";
import { g } from "../../util/index.ts";
import type { Player } from "../../../common/types.ts";

export const farmEnabled = () => isSport("hockey") && g.get("farmSystem");

// Career regular-season NHL games played. Farm players accumulate no stats
// rows, so time in the minors never counts toward losing waiver exemption.
export const careerRegularSeasonGp = (p: Pick<Player, "stats">) => {
	let gp = 0;
	for (const row of p.stats) {
		if (!row.playoffs) {
			gp += row.gp;
		}
	}

	return gp;
};

// Simplified waiver exemption: young or inexperienced players can be freely
// assigned to the farm. Veterans cannot be buried in v1 (no waiver claims).
export const isFarmEligible = (
	p: Pick<Player, "born" | "stats">,
	season = g.get("season"),
) => {
	const age = season - p.born.year;
	return (
		age <= FARM_ELIGIBLE_MAX_AGE ||
		careerRegularSeasonGp(p) < FARM_ELIGIBLE_MAX_CAREER_GP
	);
};

// Injured players can't be assigned to the farm, which also stops teams from
// burying injuries to free up active roster spots (no IR in v1).
export const canSendDown = (p: Pick<Player, "born" | "stats" | "injury">) =>
	isFarmEligible(p) && p.injury.gamesRemaining === 0;

// Salary cap charge of a contract [thousands]. Farm players get NHL-style
// buried-contract relief: only the portion above FARM_CAP_RELIEF counts.
export const capHit = (amount: number, farm: boolean | undefined) =>
	farm && farmEnabled() ? Math.max(0, amount - FARM_CAP_RELIEF) : amount;

// Partition an organization's players into active roster and farm roster
export const splitFarm = <T extends { farm?: boolean }>(players: T[]) => {
	const active: T[] = [];
	const farm: T[] = [];
	for (const p of players) {
		if (p.farm) {
			farm.push(p);
		} else {
			active.push(p);
		}
	}

	return { active, farm };
};
