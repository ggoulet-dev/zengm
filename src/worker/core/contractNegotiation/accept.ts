import { player, team } from "../index.ts";
import cancel from "./cancel.ts";
import { idb } from "../../db/index.ts";
import { g, helpers } from "../../util/index.ts";
import type {
	Conditions,
	Negotiation,
	PlayerContract,
} from "../../../common/types.ts";
import { PHASE } from "../../../common/constants.ts";
import { getRfaRightsTid } from "../freeAgents/rfa.hockey.ts";
import {
	findCompensationPicks,
	getOfferSheetCompensationRounds,
	resolveOfferSheet,
} from "../freeAgents/offerSheet.hockey.ts";

/**
 * Accept the player's offer.
 *
 * If successful, then the team's current roster will be displayed.
 *
 * @memberOf core.contractNegotiation
 * @param {number} pid An integer that must correspond with the player ID of a player in an ongoing negotiation.
 * @return {Promise.<string=>} If an error occurs, resolves to a string error message.
 */
const accept = async ({
	negotiation,
	amount,
	exp,
	dryRun,
	conditions,
}: {
	negotiation: Negotiation;
	amount: number;
	exp: number;
	dryRun?: boolean;
	conditions?: Conditions;
}) => {
	const salaryCapType = g.get("salaryCapType");

	if (salaryCapType !== "none") {
		const payroll = await team.getPayroll(g.get("userTid"));
		const birdException = negotiation.resigning && salaryCapType === "soft";

		// If this contract brings team over the salary cap, it's not a minimum contract, and it's not re-signing a current
		// player with the Bird exception, ERROR!
		if (
			!birdException &&
			payroll + amount - 1 > g.get("salaryCap") &&
			amount - 1 > g.get("minContract")
		) {
			return `You cannot go over the salary cap to sign ${
				salaryCapType === "hard" ? "players" : "free agents"
			} to contracts higher than the minimum salary.`;
		}
	}

	// This error is for sanity checking in multi team mode. Need to check for existence of negotiation.tid because it
	// wasn't there originally and I didn't write upgrade code. Can safely get rid of it later.
	if (negotiation.tid !== undefined && negotiation.tid !== g.get("userTid")) {
		return `This negotiation was started by the ${
			g.get("teamInfoCache")[negotiation.tid]?.region
		} ${g.get("teamInfoCache")[negotiation.tid]?.name} but you are the ${
			g.get("teamInfoCache")[g.get("userTid")]?.region
		} ${
			g.get("teamInfoCache")[g.get("userTid")]?.name
		}. Either switch teams or cancel this negotiation.`;
	}

	const p = await idb.cache.players.get(negotiation.pid);
	if (!p) {
		return "Invalid pid";
	}

	// Make sure the user didn't do something in another tab to change the willingness to negotiate, such as trading away players
	const mood = await player.moodInfo(p, g.get("userTid"));
	if (!mood.willing) {
		return "Player is no longer willing to negotiate.";
	}

	const contract: PlayerContract = {
		amount,
		exp,
	};
	if (p.contract.rookie && g.get("phase") === PHASE.RESIGN_PLAYERS) {
		// Not sure if the phase condition is necessary. The purpose of this is for hard cap rookies with rookie contract scale.
		contract.rookie = true;
	}

	// Hockey RFA: signing another team's tendered RFA is an offer sheet - they can match it, or take draft pick compensation from you
	const rfaRightsTid = getRfaRightsTid(p);
	if (rfaRightsTid !== undefined && rfaRightsTid !== g.get("userTid")) {
		const rounds = getOfferSheetCompensationRounds(amount);
		const picks = await findCompensationPicks(g.get("userTid"), rounds);
		if (!picks) {
			return `You cannot sign this restricted free agent to an offer sheet of that size because you do not own the draft picks required as compensation (your own ${rounds
				.map((round) => helpers.ordinal(round))
				.join(" and ")} round pick${rounds.length > 1 ? "s" : ""}).`;
		}

		if (!dryRun) {
			const result = await resolveOfferSheet({
				p,
				offerTid: g.get("userTid"),
				contract,
				conditions,
			});
			await cancel(negotiation.pid);

			if (result === "matched") {
				return `The ${g.get("teamInfoCache")[rfaRightsTid]?.region} ${
					g.get("teamInfoCache")[rfaRightsTid]?.name
				} matched your offer sheet and kept ${p.firstName} ${p.lastName}.`;
			}
		}

		return;
	}

	if (!dryRun) {
		await player.sign(p, g.get("userTid"), contract, g.get("phase"));
		await idb.cache.players.put(p);
		await cancel(negotiation.pid);
	}
};

export default accept;
