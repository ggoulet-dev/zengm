import { PLAYER } from "../../../common/constants.ts";
import { randInt, shuffle } from "../../../common/random.ts";
import type {
	Conditions,
	DraftPick,
	Player,
	PlayerContract,
} from "../../../common/types.ts";
import { orderBy } from "../../../common/utils.ts";
import { idb } from "../../db/index.ts";
import { g, helpers, local, logEvent, toUI } from "../../util/index.ts";
import { player, team } from "../index.ts";
import { ValueChangeCalculator } from "../team/ValueChangeCalculator.ts";
import {
	getRfaRightsTid,
	rfaEnabled,
	RFA_OFFER_SHEET_PREMIUM,
} from "./rfa.hockey.ts";

// NHL offer sheet compensation tiers, expressed as fractions of the salary cap
// so they scale with any league. Anchored to 2025-26: a $95.5M cap with AAV
// thresholds at $1.54M / $2.34M / $4.68M / $7.02M / $9.36M / $11.7M.
export const OFFER_SHEET_COMPENSATION_TIERS: {
	maxAavFractionOfCap: number;
	rounds: number[];
}[] = [
	{ maxAavFractionOfCap: 0.0162, rounds: [] },
	{ maxAavFractionOfCap: 0.0245, rounds: [3] },
	{ maxAavFractionOfCap: 0.049, rounds: [2] },
	{ maxAavFractionOfCap: 0.0735, rounds: [1, 3] },
	{ maxAavFractionOfCap: 0.098, rounds: [1, 2, 3] },
	{ maxAavFractionOfCap: 0.1225, rounds: [1, 1, 2, 3] },
	{ maxAavFractionOfCap: Infinity, rounds: [1, 1, 1, 1] },
];

// Chance per free agency day that the AI attempts one offer sheet league-wide.
// Offer sheets are rare in the real NHL because the right to match deters them.
export const OFFER_SHEET_AI_PROB_PER_DAY = 0.05;

// Minimum value-change for an AI team to commit picks + an overpay to an RFA
export const OFFER_SHEET_AI_DV_THRESHOLD = 8;

export const getOfferSheetCompensationRounds = (amount: number): number[] => {
	const salaryCap = g.get("salaryCap");
	for (const tier of OFFER_SHEET_COMPENSATION_TIERS) {
		if (amount <= tier.maxAavFractionOfCap * salaryCap) {
			return tier.rounds;
		}
	}

	return OFFER_SHEET_COMPENSATION_TIERS.at(-1)!.rounds;
};

// Compensation must come from the signing team's OWN picks, taken from the
// earliest future drafts where the team still owns them. Returns undefined if
// the team does not own the required picks (offer sheet not allowed, like the
// NHL).
export const findCompensationPicks = async (
	tid: number,
	rounds: number[],
): Promise<DraftPick[] | undefined> => {
	if (rounds.length === 0) {
		return [];
	}

	if (Math.max(...rounds) > g.get("numDraftRounds")) {
		return undefined;
	}

	const allPicks = await idb.cache.draftPicks.indexGetAll(
		"draftPicksByTid",
		tid,
	);
	const ownPicks = allPicks.filter(
		(dp) => dp.originalTid === tid && typeof dp.season === "number",
	);

	const countsByRound = new Map<number, number>();
	for (const round of rounds) {
		countsByRound.set(round, (countsByRound.get(round) ?? 0) + 1);
	}

	const picks: DraftPick[] = [];
	for (const [round, count] of countsByRound) {
		const ownInRound = orderBy(
			ownPicks.filter((dp) => dp.round === round),
			"season",
			"asc",
		);
		if (ownInRound.length < count) {
			return undefined;
		}

		picks.push(...ownInRound.slice(0, count));
	}

	return picks;
};

const formatCompensation = (picks: DraftPick[]) => {
	if (picks.length === 0) {
		return "no compensation";
	}

	const countsByRound = new Map<number, number>();
	for (const dp of picks) {
		countsByRound.set(dp.round, (countsByRound.get(dp.round) ?? 0) + 1);
	}

	const parts = [...countsByRound]
		.sort((a, b) => a[0] - b[0])
		.map(([round, count]) =>
			count === 1
				? `a ${helpers.ordinal(round)} round pick`
				: `${count} ${helpers.ordinal(round)} round picks`,
		);

	return parts.join(" and ");
};

const teamName = (tid: number) => {
	const t = g.get("teamInfoCache")[tid];
	return t ? `${t.region} ${t.name}` : "???";
};

const playerLink = (p: Player) =>
	`<a href="${helpers.leagueUrl(["player", p.pid])}">${p.firstName} ${
		p.lastName
	}</a>`;

const contractText = (contract: PlayerContract) => {
	const years = contract.exp - g.get("season");
	return `${years}-year, ${helpers.formatCurrency(
		contract.amount / 1000,
		"M",
	)} per year`;
};

const signWithTeam = async (
	p: Player,
	tid: number,
	contract: PlayerContract,
) => {
	await player.sign(p, tid, contract, g.get("phase"));
	await idb.cache.players.put(p);
	await team.rosterAutoSort(tid);
};

// Should the AI rights team match the offer sheet? Keep the player if he is
// worth more to the roster than the compensation picks, and the cap allows it.
const decideMatchAi = async (
	p: Player,
	rightsTid: number,
	contract: PlayerContract,
	picks: DraftPick[],
) => {
	const vcc = new ValueChangeCalculator();

	// Matching means paying the offer sheet terms, not the player's discounted asking price. p is the live cache object, so evaluate() sees this temporary contract.
	const actualContract = p.contract;
	p.contract = {
		...actualContract,
		amount: contract.amount,
		exp: contract.exp,
	};
	let dvKeep;
	try {
		dvKeep = await vcc.evaluate({
			tid: rightsTid,
			pidsAdd: [p.pid],
			pidsRemove: [],
			dpidsAdd: [],
			dpidsRemove: [],
			tradingPartnerTid: undefined,
		});
	} finally {
		p.contract = actualContract;
	}

	const dvPicks = await vcc.evaluate({
		tid: rightsTid,
		pidsAdd: [],
		pidsRemove: [],
		dpidsAdd: picks.map((dp) => dp.dpid),
		dpidsRemove: [],
		tradingPartnerTid: undefined,
	});

	return dvKeep > dvPicks;
};

// Resolve a signed offer sheet: the rights team matches (keeps the player at
// the offered terms) or takes the draft pick compensation. Callers must have
// validated: p is a tendered RFA, offerTid !== rights team, the offering team
// owns the required picks and can fit the contract.
export const resolveOfferSheet = async ({
	p,
	offerTid,
	contract,
	conditions,
}: {
	p: Player;
	offerTid: number;
	contract: PlayerContract;
	conditions?: Conditions;
}): Promise<"matched" | "signed"> => {
	const rightsTid = getRfaRightsTid(p);
	if (rightsTid === undefined) {
		throw new Error("This player is not a restricted free agent");
	}

	const rounds = getOfferSheetCompensationRounds(contract.amount);
	const picks = await findCompensationPicks(offerTid, rounds);
	if (!picks) {
		throw new Error(
			"Team does not own the draft picks required as compensation",
		);
	}

	// Rights held by a disabled team are dead - sign outright, no match, no compensation
	const rightsTeam = await idb.cache.teams.get(rightsTid);
	if (!rightsTeam || rightsTeam.disabled) {
		await signWithTeam(p, offerTid, contract);
		return "signed";
	}

	// A team that cannot fit the contract under a hard cap cannot match
	let canMatch = true;
	if (g.get("salaryCapType") === "hard") {
		const payroll = await team.getPayroll(rightsTid);
		canMatch = payroll + contract.amount <= g.get("salaryCap");
	}

	const userIsRightsTeam =
		g.get("userTids").includes(rightsTid) &&
		!local.autoPlayUntil &&
		!g.get("spectator");

	let match = false;
	if (canMatch) {
		if (userIsRightsTeam) {
			match = await toUI(
				"confirm",
				[
					`The ${teamName(offerTid)} signed your restricted free agent ${
						p.firstName
					} ${p.lastName} to a ${contractText(
						contract,
					)} offer sheet. If you decline to match, you will receive ${formatCompensation(
						picks,
					)} from them.`,
					{
						okText: "Match offer sheet",
						cancelText: "Take the compensation",
					},
				],
				conditions,
			);
		} else {
			match = await decideMatchAi(p, rightsTid, contract, picks);
		}
	}

	if (match) {
		await signWithTeam(p, rightsTid, contract);
		logEvent(
			{
				type: "reSigned",
				text: `The ${teamName(rightsTid)} matched the ${teamName(
					offerTid,
				)}' offer sheet and re-signed ${playerLink(p)} to a ${contractText(
					contract,
				)} contract.`,
				showNotification:
					g.get("userTids").includes(rightsTid) ||
					g.get("userTids").includes(offerTid),
				pids: [p.pid],
				tids: [rightsTid],
				score: 10,
			},
			conditions,
		);

		return "matched";
	}

	for (const dp of picks) {
		dp.tid = rightsTid;
		await idb.cache.draftPicks.put(dp);
	}

	await signWithTeam(p, offerTid, contract);
	logEvent(
		{
			type: "freeAgent",
			text: `${playerLink(p)} signed a ${contractText(
				contract,
			)} offer sheet with the ${teamName(offerTid)}. The ${teamName(
				rightsTid,
			)} declined to match and will receive ${formatCompensation(
				picks,
			)} as compensation.`,
			showNotification:
				g.get("userTids").includes(rightsTid) ||
				g.get("userTids").includes(offerTid),
			pids: [p.pid],
			tids: [offerTid],
			score: 20,
		},
		conditions,
	);

	return "signed";
};

// Once in a while during free agency, an AI team tries to poach a tendered RFA
// with an offer sheet.
export const runAiOfferSheets = async (conditions: Conditions) => {
	if (!rfaEnabled()) {
		return;
	}

	if (Math.random() >= OFFER_SHEET_AI_PROB_PER_DAY) {
		return;
	}

	const freeAgents = await idb.cache.players.indexGetAll(
		"playersByTid",
		PLAYER.FREE_AGENT,
	);
	const candidates = orderBy(
		freeAgents.filter((p) => getRfaRightsTid(p) !== undefined),
		"value",
		"desc",
	).slice(0, 5) as Player[];
	if (candidates.length === 0) {
		return;
	}

	const teams = await idb.cache.teams.getAll();
	shuffle(teams);

	const vcc = new ValueChangeCalculator();
	for (const p of candidates) {
		const rightsTid = getRfaRightsTid(p)!;
		const amount = helpers.bound(
			helpers.roundContract(
				p.contract.amount * (RFA_OFFER_SHEET_PREMIUM + Math.random() * 0.15),
			),
			g.get("minContract"),
			g.get("maxContract"),
		);
		const rounds = getOfferSheetCompensationRounds(amount);

		for (const t of teams) {
			if (t.tid === rightsTid || t.disabled) {
				continue;
			}

			// The user makes their own offer sheets
			if (
				g.get("userTids").includes(t.tid) &&
				!local.autoPlayUntil &&
				!g.get("spectator")
			) {
				continue;
			}

			const payroll = await team.getPayroll(t.tid);
			if (
				g.get("salaryCapType") !== "none" &&
				payroll + amount > g.get("salaryCap")
			) {
				continue;
			}

			const picks = await findCompensationPicks(t.tid, rounds);
			if (!picks) {
				continue;
			}

			const dv = await vcc.evaluate({
				tid: t.tid,
				pidsAdd: [p.pid],
				pidsRemove: [],
				dpidsAdd: [],
				dpidsRemove: picks.map((dp) => dp.dpid),
				tradingPartnerTid: undefined,
			});
			if (dv <= OFFER_SHEET_AI_DV_THRESHOLD) {
				continue;
			}

			const contract = {
				amount,
				exp: g.get("season") + randInt(2, 4),
			};
			await resolveOfferSheet({ p, offerTid: t.tid, contract, conditions });

			// At most one offer sheet per day
			return;
		}
	}
};
