import { idb } from "../../db/index.ts";
import { g, local } from "../../util/index.ts";
import isUntradable from "./isUntradable.ts";
import makeItWork from "./makeItWork.ts";
import processTrade from "./processTrade.ts";
import summary from "./summary.ts";
import type { TradeTeams } from "../../../common/types.ts";
import { bySport, isSport } from "../../../common/sportFunctions.ts";
import { choice } from "../../../common/random.ts";
import { ValueChangeCalculator } from "../team/ValueChangeCalculator.ts";
import type { ContentionPhase } from "../team/contentionPhase.ts";
import { PHASE } from "../../../common/constants.ts";
import getSchedule from "../season/getSchedule.ts";
import {
	COMPLEMENTARY_PARTNER_WEIGHT,
	FRENZY_COMPLEMENTARY_PARTNER_WEIGHT,
	FRENZY_EXPIRING_CONTRACT_WEIGHT,
	FRENZY_SELLER_VETERAN_AMPLIFIER,
	getTradeFrenzyFactor,
} from "./frenzy.ts";

const getAITids = async () => {
	const teams = await idb.cache.teams.getAll();
	return teams
		.filter((t) => {
			if (t.disabled) {
				return false;
			}

			if (
				(local.autoPlayUntil || g.get("spectator")) &&
				!g.get("challengeNoTrades")
			) {
				return true;
			}
			return !g.get("userTids").includes(t.tid);
		})
		.map((t) => t.tid);
};

// Game days until the trade deadline sentinel game (awayTid/homeTid -3) in the remaining schedule. undefined if there is no deadline to consider, negative if it already passed. Non-throwing, unlike getDaysLeftSchedule, because the sentinel is often absent (deadline disabled, free agency call site, after the deadline).
const getDaysUntilTradeDeadline = async (): Promise<number | undefined> => {
	if (g.get("tradeDeadline") >= 1) {
		// Trade deadline disabled, no sentinel game exists
		return undefined;
	}

	const phase = g.get("phase");
	if (phase === PHASE.AFTER_TRADE_DEADLINE) {
		return -1;
	}
	if (phase !== PHASE.REGULAR_SEASON) {
		// No regular season schedule to look at (e.g. the free agency call site)
		return undefined;
	}

	const schedule = await getSchedule();
	const today = schedule[0]?.day;
	const deadlineGame = schedule.find(
		(game) => game.awayTid === -3 && game.homeTid === -3,
	);
	if (today === undefined || deadlineGame === undefined) {
		return undefined;
	}

	return deadlineGame.day - today;
};

const attempt = async (
	valueChangeCalculator: ValueChangeCalculator,
	frenzy: boolean,
) => {
	const aiTids = await getAITids();

	if (aiTids.length === 0) {
		return false;
	}

	const tid = choice(aiTids);
	const otherTids = aiTids.filter((tid2) => tid !== tid2);

	if (otherTids.length === 0) {
		return false;
	}

	// NHL-style lifecycle bias (hockey only, phase is undefined elsewhere): sellers shop their veterans to buyers, buyers dangle futures at sellers
	const phase = isSport("hockey")
		? await valueChangeCalculator.getContentionPhase(tid)
		: undefined;
	const isSeller = phase === "teardown" || phase === "accumulation";
	const isBuyer = phase === "push" || phase === "winNow";

	let otherTid: number;
	if (isSeller || isBuyer) {
		const otherPhases = new Map<number, ContentionPhase | undefined>();
		for (const tid2 of otherTids) {
			otherPhases.set(
				tid2,
				await valueChangeCalculator.getContentionPhase(tid2),
			);
		}

		// During the deadline frenzy, sellers and buyers seek each other out even more aggressively
		const complementaryWeight = frenzy
			? FRENZY_COMPLEMENTARY_PARTNER_WEIGHT
			: COMPLEMENTARY_PARTNER_WEIGHT;
		otherTid = choice(otherTids, (tid2) => {
			const phase2 = otherPhases.get(tid2);
			const complementary = isSeller
				? phase2 === "push" || phase2 === "winNow"
				: phase2 === "teardown" || phase2 === "accumulation";
			return complementary ? complementaryWeight : 1;
		})!;
	} else {
		otherTid = choice(otherTids);
	}

	const players = (
		await idb.cache.players.indexGetAll("playersByTid", tid)
	).filter((p) => !isUntradable(p).untradable);
	const draftPicks = await idb.cache.draftPicks.indexGetAll(
		"draftPicksByTid",
		tid,
	);

	if (players.length === 0 && draftPicks.length === 0) {
		return false;
	}

	// Weight by player value - good player more likely to be in trade. Sellers shop veterans and protect their young core, buyers do the opposite.
	const season = g.get("season");
	const playerWeight = (p: (typeof players)[number]) => {
		let weight = p.value;
		const age = season - p.born.year;

		if (isSeller) {
			if (age >= 27) {
				weight *= frenzy ? 2.5 * FRENZY_SELLER_VETERAN_AMPLIFIER : 2.5;
			} else if (age <= 23) {
				weight *= 0.4;
			}

			// Rentals are THE deadline commodity
			if (frenzy && p.contract.exp === season) {
				weight *= FRENZY_EXPIRING_CONTRACT_WEIGHT;
			}
		} else if (isBuyer) {
			if (age <= 23) {
				weight *= 2;
			} else if (age >= 27) {
				weight *= 0.5;
			}
		}

		return weight;
	};

	const r = Math.random();
	const pids: number[] = [];
	const dpids: number[] = [];

	// Buyers lead with draft picks more often
	const playerFirstProb = isBuyer ? 0.45 : 0.7;

	if ((r < playerFirstProb || draftPicks.length === 0) && players.length > 0) {
		const p = choice(players, playerWeight);
		if (!p) {
			return false;
		}
		pids.push(p.pid);
	} else if ((r < 0.85 || players.length === 0) && draftPicks.length > 0) {
		dpids.push(choice(draftPicks).dpid);
	} else {
		const p = choice(players, playerWeight);
		const dp = choice(draftPicks);
		if (!p || !dp) {
			return false;
		}
		pids.push(p.pid);
		dpids.push(dp.dpid);
	}

	const teams0: TradeTeams = [
		{
			dpids,
			dpidsExcluded: [],
			pids,
			pidsExcluded: [],
			tid,
		},
		{
			dpids: [],
			dpidsExcluded: [],
			pids: [],
			pidsExcluded: [],
			tid: otherTid,
		},
	];

	const teams = await makeItWork(teams0, {
		holdUserConstant: false,
		maxAssetsToAdd: 5,
		valueChangeCalculator,
	});

	if (!teams) {
		return false;
	}

	// Don't do trades of just picks, it's weird usually
	if (teams[0].pids.length === 0 && teams[1].pids.length === 0) {
		return false;
	}

	// Don't do trades for nothing, it's weird usually
	if (teams[1].pids.length === 0 && teams[1].dpids.length === 0) {
		return false;
	}

	const tradeSummary = await summary(teams);

	if (tradeSummary.warning) {
		return false;
	}

	// Make sure this isn't a really shitty trade. dv2 is from the perspective of the initiating team - makeItWork only guarantees the trade is positive for the other team, so without a floor here the initiating team can knowingly give away a star for scraps. The floor is much tighter in hockey because its value scale (EXPONENT 3.5) makes -15 as large as a star player given away for nothing.
	const dv2 = await valueChangeCalculator.evaluate({
		tid: teams[0].tid,
		pidsAdd: teams[1].pids,
		pidsRemove: teams[0].pids,
		dpidsAdd: teams[1].dpids,
		dpidsRemove: teams[0].dpids,
		tradingPartnerTid: undefined,
	});
	// The winNow phase multipliers already make contenders willing to overpay for veterans, so the floor stays uniform - relaxing it further would let buyers bleed their young core for nothing
	const minDv2 = bySport({
		hockey: -3,
		default: -15,
	});
	if (dv2 < minDv2 || dv2 > 15) {
		return false;
	}

	const finalTids: [number, number] = [teams[0].tid, teams[1].tid];
	const finalPids: [number[], number[]] = [teams[0].pids, teams[1].pids];
	const finalDpids: [number[], number[]] = [teams[0].dpids, teams[1].dpids];
	await processTrade(finalTids, finalPids, finalDpids);

	return finalTids;
};

const DEFAULT_NUM_TEAMS = 30;

const betweenAiTeams = async () => {
	if (g.get("forceHistoricalRosters")) {
		return false;
	}

	// If aiTradesFactor is not an integer, use the fractional part as a probability. Like for 3.5, 50% of the times it will be 3, and 50% will be 4.
	// Also scale so there are fewer trade attempts if there are fewer teams.
	let float = g.get("aiTradesFactor");
	if (isSport("baseball")) {
		float *= 0.25;
	}
	if (g.get("numActiveTeams") < DEFAULT_NUM_TEAMS) {
		float *= g.get("numActiveTeams") / DEFAULT_NUM_TEAMS;
	}

	// NHL-style deadline frenzy (hockey only): volume spikes approaching the trade deadline and is halved the rest of the season
	let frenzy = false;
	if (isSport("hockey")) {
		const daysUntilDeadline = await getDaysUntilTradeDeadline();
		const frenzyFactor = getTradeFrenzyFactor(daysUntilDeadline);
		float *= frenzyFactor;
		frenzy = frenzyFactor > 1;
	}

	let numAttempts = Math.floor(float);
	const remainder = float % 1;
	if (remainder > 0 && Math.random() < remainder) {
		numAttempts += 1;
	}

	if (numAttempts > 0) {
		const valueChangeCalculator = new ValueChangeCalculator();

		for (let i = 0; i < numAttempts; i++) {
			const tradeTids = await attempt(valueChangeCalculator, frenzy);
			if (tradeTids) {
				// Don't need to recompute draft pick value
				valueChangeCalculator.invalidateCache({ teams: tradeTids });
			}
		}
	}
};

export default betweenAiTeams;
