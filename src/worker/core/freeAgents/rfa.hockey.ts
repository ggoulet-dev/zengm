import { isSport } from "../../../common/sportFunctions.ts";
import { g, helpers } from "../../util/index.ts";
import { last } from "../../../common/utils.ts";
import type { Player, PlayerWithoutKey } from "../../../common/types.ts";

// NHL Group 2 RFA rules: a player with an expiring contract is restricted unless
// he is 27+ or has 7+ accrued seasons (40 GP for skaters, 30 for goalies).
export const RFA_UFA_AGE = 27;
export const RFA_UFA_ACCRUED_SEASONS = 7;
export const RFA_ACCRUED_SEASON_GP_SKATER = 40;
export const RFA_ACCRUED_SEASON_GP_GOALIE = 30;

// Tendered RFAs accept bridge deals below their open-market demand
export const RFA_DEMAND_FACTOR = 0.85;

// Asking price premium it takes for another team's offer sheet to tempt an RFA
export const RFA_OFFER_SHEET_PREMIUM = 1.2;

// Per free agency day, the chance an AI team re-signs each of its own tendered
// RFAs. Low enough to leave a window for offer sheets, high enough that almost
// every RFA is signed before the season (1 - 0.85^30 ≈ 99.2% over 30 days).
export const RFA_AI_RESIGN_PROB_PER_DAY = 0.15;

export const rfaEnabled = () => isSport("hockey") && g.get("rfa");

type PlayerLean = Pick<
	Player,
	"born" | "ratings" | "stats" | "rfaTid" | "contract" | "value"
>;

export const countAccruedSeasons = (p: PlayerLean) => {
	const threshold =
		last(p.ratings).pos === "G"
			? RFA_ACCRUED_SEASON_GP_GOALIE
			: RFA_ACCRUED_SEASON_GP_SKATER;

	// Sum games played per season, because a traded player has multiple stats rows in one season
	const gpBySeason = new Map<number, number>();
	for (const row of p.stats) {
		if (row.playoffs) {
			continue;
		}
		gpBySeason.set(row.season, (gpBySeason.get(row.season) ?? 0) + row.gp);
	}

	let accrued = 0;
	for (const gp of gpBySeason.values()) {
		if (gp >= threshold) {
			accrued += 1;
		}
	}

	return accrued;
};

// Would this player be restricted (rather than unrestricted) if his contract expired now?
export const isRfaEligible = (p: PlayerLean, season = g.get("season")) => {
	if (!rfaEnabled()) {
		return false;
	}

	const age = season - p.born.year;
	if (age >= RFA_UFA_AGE) {
		return false;
	}

	return countAccruedSeasons(p) < RFA_UFA_ACCRUED_SEASONS;
};

// The team currently holding this free agent's RFA rights, if any. Rights lapse
// once the player ages/accrues out of RFA eligibility.
export const getRfaRightsTid = (
	p: PlayerLean,
	season = g.get("season"),
): number | undefined => {
	if (p.rfaTid === undefined || p.rfaTid < 0) {
		return undefined;
	}

	if (!isRfaEligible(p, season)) {
		return undefined;
	}

	return p.rfaTid;
};

// Tender a qualifying offer: the team keeps exclusive rights and the player's
// asking price drops to bridge-deal territory.
export const tenderQualifyingOffer = (p: PlayerWithoutKey, tid: number) => {
	p.rfaTid = tid;
	p.contract.amount = helpers.bound(
		helpers.roundContract(p.contract.amount * RFA_DEMAND_FACTOR),
		g.get("minContract"),
		g.get("maxContract"),
	);
};
