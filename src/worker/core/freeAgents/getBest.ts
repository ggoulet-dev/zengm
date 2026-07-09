import { g } from "../../util/index.ts";
import type { PlayerWithoutKey } from "../../../common/types.ts";
import {
	DRAFT_BY_TEAM_OVR,
	POSITION_COUNTS,
} from "../../../common/constants.ts";
import { getTeamOvrDiffs } from "../draft/runPicks.ts";
import { last, orderBy } from "../../../common/utils.ts";
import { bySport } from "../../../common/sportFunctions.ts";

// In some sports, extra check for certain important rare positions in case the only one was traded away. These should only be positions with weird unique skills, where you can't replace them easily with another position. Value is the number of players that should be at each position.
export const KEY_POSITIONS_NEEDED = bySport<Record<string, number> | undefined>(
	{
		baseball: undefined,
		basketball: undefined,
		football: { QB: 2, K: 1, P: 1 },
		hockey: { G: 2 },
	},
);

// How many players the AI should actually roster. In leagues where maxRosterSize is much larger than a functional roster (like NHL leagues using the 50-contract limit), filling all the way to maxRosterSize just hoards fungible players, so stop once a full lineup plus a couple spares is covered.
export const getAiRosterTarget = () => {
	const maxRosterSize = g.get("maxRosterSize");

	let positionCountsTotal = 0;
	for (const count of Object.values(POSITION_COUNTS)) {
		positionCountsTotal += count;
	}
	if (positionCountsTotal === 0) {
		return maxRosterSize - 2;
	}

	return Math.min(
		maxRosterSize - 2,
		Math.max(Math.round(positionCountsTotal) + 2, g.get("minRosterSize") + 2),
	);
};

// Find the best available free agent for a team.
// playersAvailable should be sorted - best players first, worst players last.
// If payroll is not supplied, don't do salary cap check (like when creating new league).
const getBest = <T extends PlayerWithoutKey>(
	playersOnRoster: T[],
	playersAvailable: T[],
	payroll?: number,
): T | void => {
	const minContract = g.get("minContract");
	const salaryCap = g.get("salaryCap");
	const salaryCapType = g.get("salaryCapType");
	const numActiveTeams = g.get("numActiveTeams");

	const aiRosterTarget = getAiRosterTarget();

	// Position counts of the current roster, to keep min-contract filler from stacking one position (like 11 centers when POSITION_COUNTS says 5)
	let positionCountsRoster: Record<string, number> | undefined;
	if (Object.keys(POSITION_COUNTS).length > 0) {
		positionCountsRoster = {};
		for (const p of playersOnRoster) {
			const pos = last(p.ratings).pos;
			positionCountsRoster[pos] = (positionCountsRoster[pos] ?? 0) + 1;
		}
	}

	let playersSorted: T[];
	if (DRAFT_BY_TEAM_OVR) {
		// playersAvailable is sorted by value. So if we hit a player at a minimum contract at a position, no player with lower value needs to be considered
		const seenMinContractAtPos = new Set();
		const playersAvailableFiltered = playersAvailable.filter((p) => {
			const pos = last(p.ratings).pos;
			if (seenMinContractAtPos.has(pos)) {
				return false;
			}

			if (p.contract.amount <= minContract && p.injury.gamesRemaining === 0) {
				seenMinContractAtPos.add(pos);
			}

			return true;
		});

		const teamOvrDiffs = getTeamOvrDiffs(
			playersOnRoster,
			playersAvailableFiltered,
		);
		const wrapper = playersAvailableFiltered.map((p, i) => ({
			p,
			teamOvrDiff: teamOvrDiffs[i]!,
		}));
		playersSorted = orderBy(wrapper, (x) => x.teamOvrDiff, "desc").map(
			(x) => x.p,
		);
	} else {
		playersSorted = playersAvailable;
	}

	const skipSalaryCapCheck =
		salaryCapType === "none" && Math.random() < 2 / numActiveTeams;

	let keyPositionsNeededCache: Set<string> | undefined;
	const getKeyPositionsNeeded = () => {
		if (KEY_POSITIONS_NEEDED) {
			if (keyPositionsNeededCache) {
				return keyPositionsNeededCache;
			}

			const allKeyPositionsNeeded = Object.keys(KEY_POSITIONS_NEEDED);
			const positionCounts: Record<
				"injured" | "healthy",
				Record<string, number>
			> = {
				injured: {},
				healthy: {},
			};

			for (const p of playersOnRoster) {
				const pos = last(p.ratings).pos;
				const injured = p.injury.gamesRemaining > 0;
				const object = positionCounts[injured ? "injured" : "healthy"];
				object[pos] ??= 0;
				object[pos] += 1;
			}

			keyPositionsNeededCache = new Set(
				allKeyPositionsNeeded.filter((pos) => {
					const injured = positionCounts.injured[pos] ?? 0;
					const healthy = positionCounts.healthy[pos] ?? 0;

					// If we already have 4 injured ones, maybe don't sign another? idk
					if (injured >= 4) {
						return false;
					}

					return (
						healthy === 0 || healthy + injured < KEY_POSITIONS_NEEDED[pos]!
					);
				}),
			);

			return keyPositionsNeededCache;
		}
	};

	for (const p of playersSorted) {
		const salaryCapCheck =
			payroll === undefined ||
			skipSalaryCapCheck ||
			p.contract.amount + payroll <= salaryCap;

		// A position is full for filler purposes once the roster covers its POSITION_COUNTS share
		const pos = last(p.ratings).pos;
		const positionFull =
			positionCountsRoster !== undefined &&
			POSITION_COUNTS[pos] !== undefined &&
			(positionCountsRoster[pos] ?? 0) >= Math.ceil(POSITION_COUNTS[pos]);

		// Don't sign minimum contract players to fill out the roster
		const shouldAddPlayerNormal =
			salaryCapCheck &&
			p.contract.amount > minContract &&
			playersOnRoster.length < aiRosterTarget + 3;
		const shouldAddPlayerMinContract =
			p.contract.amount <= minContract &&
			playersOnRoster.length < aiRosterTarget &&
			!positionFull;

		// If none of the other checks were true and we can afford this player and it's at a position we have nobody at (like hockey goalie), go for it
		const shouldAddPlayerPosition =
			p.injury.gamesRemaining === 0 &&
			!shouldAddPlayerNormal &&
			!shouldAddPlayerMinContract &&
			(salaryCapCheck || p.contract.amount <= minContract) &&
			getKeyPositionsNeeded()?.has(pos);

		if (
			shouldAddPlayerNormal ||
			shouldAddPlayerPosition ||
			shouldAddPlayerMinContract
		) {
			return p;
		}
	}
};

export default getBest;
