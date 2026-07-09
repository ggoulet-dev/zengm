import { PLAYER } from "../../../common/constants.ts";
import { player, team } from "../index.ts";
import getBest from "./getBest.ts";
import { idb } from "../../db/index.ts";
import { g, local } from "../../util/index.ts";
import { orderBy } from "../../../common/utils.ts";
import { isSport } from "../../../common/sportFunctions.ts";
import { shuffle } from "../../../common/random.ts";
import { getRfaRightsTid, RFA_AI_RESIGN_PROB_PER_DAY } from "./rfa.hockey.ts";
import { ValueChangeCalculator } from "../team/ValueChangeCalculator.ts";
import type { ContentionPhase } from "../team/contentionPhase.ts";

// AI free-agent aggressiveness by NHL-style contention phase (hockey only). Rebuilders mostly sit
// out free agency, contenders shop hard. This replaces the flat 0.5 skip that made every AI team
// behave identically regardless of where it was in its competitive cycle.
const HOCKEY_FA_PROB_SKIP: Record<ContentionPhase, number> = {
	teardown: 0.9,
	accumulation: 0.82,
	emergence: 0.55,
	push: 0.4,
	winNow: 0.25,
};

// Rebuilding teams (teardown/accumulation) avoid signing aging veterans, who don't fit the timeline
// and just block young players - they only reach for one if no younger free agent is available.
const HOCKEY_FA_REBUILDER_MAX_AGE = 29;

/**
 * AI teams sign free agents.
 *
 * Each team (in random order) will sign free agents up to their salary cap or roster size limit. This should eventually be made smarter
 *
 * @memberOf core.freeAgents
 * @return {Promise}
 */
const autoSign = async () => {
	const players = await idb.cache.players.indexGetAll(
		"playersByTid",
		PLAYER.FREE_AGENT,
	);

	if (players.length === 0) {
		return;
	}

	// List of free agents, sorted by value
	let playersSorted = orderBy(players, "value", "desc");

	// Randomly order teams
	const teams = await idb.cache.teams.getAll();
	shuffle(teams);

	// Hockey: classify each team's contention phase once up front so AI free agency reflects whether
	// a team is rebuilding or contending. Falls back to the old flat behavior if team valuation data
	// isn't available for some reason.
	let contentionPhases: Record<number, ContentionPhase | undefined> | undefined;
	if (isSport("hockey")) {
		try {
			const valueChangeCalculator = new ValueChangeCalculator();
			contentionPhases = {};
			for (const t of teams) {
				contentionPhases[t.tid] =
					await valueChangeCalculator.getContentionPhase(t.tid);
			}
		} catch {
			contentionPhases = undefined;
		}
	}

	for (const t of teams) {
		// Skip the user's team
		if (
			g.get("userTids").includes(t.tid) &&
			!local.autoPlayUntil &&
			!g.get("spectator")
		) {
			continue;
		}

		if (t.disabled) {
			continue;
		}

		// Hockey RFA: re-sign own tendered RFAs, each with a daily probability so a window stays open for offer sheets early in free agency. At the end of free agency (and during the season), sign them as soon as the cap allows.
		const tenderedRfas = playersSorted.filter(
			(p2) => getRfaRightsTid(p2) === t.tid,
		);
		const rfaMustSignNow = g.get("daysLeft") <= 5;
		for (const p2 of tenderedRfas) {
			if (!rfaMustSignNow && Math.random() >= RFA_AI_RESIGN_PROB_PER_DAY) {
				continue;
			}

			const payroll = await team.getPayroll(t.tid);
			if (
				g.get("salaryCapType") !== "none" &&
				payroll + p2.contract.amount > g.get("salaryCap")
			) {
				continue;
			}

			playersSorted = playersSorted.filter((p3) => p3 !== p2);
			await player.sign(p2, t.tid, p2.contract, g.get("phase"));
			await idb.cache.players.put(p2);
			await team.rosterAutoSort(t.tid);
		}

		const contentionPhase = contentionPhases?.[t.tid];

		let probSkip;
		if (isSport("basketball")) {
			probSkip = t.strategy === "rebuilding" ? 0.9 : 0.75;
		} else if (contentionPhase) {
			probSkip = HOCKEY_FA_PROB_SKIP[contentionPhase];
		} else {
			probSkip = 0.5;
		}

		// Skip teams sometimes
		if (Math.random() < probSkip) {
			continue;
		}

		const playersOnRoster = await idb.cache.players.indexGetAll(
			"playersByTid",
			t.tid,
		);

		// With forceHistoricalRosters, only sign FAs if we have to
		if (
			playersOnRoster.length >= g.get("minRosterSize") &&
			g.get("forceHistoricalRosters")
		) {
			continue;
		}

		// Ignore roster size, will drop bad player if necessary in checkRosterSizes, and getBest won't sign min contract player unless under the roster limit
		const payroll = await team.getPayroll(t.tid);

		// Hockey RFA: tendered RFAs can only be signed outright by their rights team (other teams need an offer sheet)
		let playersAvailable = playersSorted.filter((p2) => {
			const rightsTid = getRfaRightsTid(p2);
			return rightsTid === undefined || rightsTid === t.tid;
		});

		// Rebuilding teams pass on aging veterans unless nothing younger is left
		if (contentionPhase === "teardown" || contentionPhase === "accumulation") {
			const youngEnough = playersAvailable.filter(
				(p2) => g.get("season") - p2.born.year < HOCKEY_FA_REBUILDER_MAX_AGE,
			);
			if (youngEnough.length > 0) {
				playersAvailable = youngEnough;
			}
		}

		const p = getBest(playersOnRoster, playersAvailable, payroll);
		if (p) {
			// Remove from list of free agents
			playersSorted = playersSorted.filter((p2) => p2 !== p);

			await player.sign(p, t.tid, p.contract, g.get("phase"));
			await idb.cache.players.put(p);
			await team.rosterAutoSort(t.tid);
		}
	}
};

export default autoSign;
