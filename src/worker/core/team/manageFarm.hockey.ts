import { idb } from "../../db/index.ts";
import { g, local } from "../../util/index.ts";
import {
	FARM_ACTIVE_TARGETS,
	FARM_PROMOTE_MARGIN,
} from "../../../common/constants.hockey.ts";
import { canSendDown, farmEnabled, splitFarm } from "./farm.hockey.ts";
import rosterAutoSort from "./rosterAutoSort.ts";
import type { Player } from "../../../common/types.ts";
import { last, orderBy } from "../../../common/utils.ts";

type Group = keyof typeof FARM_ACTIVE_TARGETS;

// C/W collapse into F because dressing operates on forward lines
const getGroup = (p: Player): Group => {
	const pos = last(p.ratings).pos;
	if (pos === "G" || pos === "D") {
		return pos;
	}
	return "F";
};

const healthy = (p: Player) => p.injury.gamesRemaining === 0;

/**
 * Daily AI farm management for one team. Deterministic and cheap: one pass over
 * the organization, at most a handful of moves per day.
 *
 * a) Surplus: while the active roster is over maxRosterSize, send down the
 *    worst-value eligible active, preferring groups above their targets.
 * b) Need: while a dressing group has fewer healthy actives than its target,
 *    call up the best healthy farm player of that group (swapping out a
 *    surplus-group active when the roster is full).
 * c) Quality: promote a farm player over a clearly worse active at the same
 *    group. The FARM_PROMOTE_MARGIN makes oscillation impossible — the reverse
 *    swap would require the demoted player to also be better by the margin.
 *
 * Returns the moved players' pids (already written to the cache). Caller is
 * responsible for rosterAutoSort when anything moved.
 */
export const manageFarmTeam = async (tid: number): Promise<number[]> => {
	if (!farmEnabled()) {
		return [];
	}

	const players = await idb.cache.players.indexGetAll("playersByTid", tid);
	const { active, farm } = splitFarm(players);

	const maxRosterSize = g.get("maxRosterSize");
	const movedPids: number[] = [];

	const healthyActiveCounts: Record<Group, number> = { F: 0, D: 0, G: 0 };
	for (const p of active) {
		if (healthy(p)) {
			healthyActiveCounts[getGroup(p)] += 1;
		}
	}

	const sendDown = (p: Player) => {
		p.farm = true;
		active.splice(active.indexOf(p), 1);
		farm.push(p);
		if (healthy(p)) {
			healthyActiveCounts[getGroup(p)] -= 1;
		}
		movedPids.push(p.pid);
	};

	const callUp = (p: Player) => {
		delete p.farm;
		farm.splice(farm.indexOf(p), 1);
		active.push(p);
		if (healthy(p)) {
			healthyActiveCounts[getGroup(p)] += 1;
		}
		movedPids.push(p.pid);
	};

	// Worst-value active that can be sent down, preferring groups above target so the send-down doesn't create a need
	const findDemotionCandidate = (requireSurplusGroup: boolean) => {
		const candidates = orderBy(
			active.filter(
				(p) =>
					canSendDown(p) &&
					(!requireSurplusGroup ||
						healthyActiveCounts[getGroup(p)] >
							FARM_ACTIVE_TARGETS[getGroup(p)]),
			),
			"value",
			"asc",
		);
		return candidates[0];
	};

	// a) Surplus
	while (active.length > maxRosterSize) {
		const p = findDemotionCandidate(true) ?? findDemotionCandidate(false);
		if (!p) {
			// Nobody is waiver-exempt; checkRosterSizes will release instead
			break;
		}
		sendDown(p);
	}

	// b) Need
	for (const group of Object.keys(FARM_ACTIVE_TARGETS) as Group[]) {
		while (healthyActiveCounts[group] < FARM_ACTIVE_TARGETS[group]) {
			const candidates = orderBy(
				farm.filter((p) => healthy(p) && getGroup(p) === group),
				"value",
				"desc",
			);
			const callUpTarget = candidates[0];
			if (!callUpTarget) {
				break;
			}

			if (active.length >= maxRosterSize) {
				const donor = findDemotionCandidate(true);
				if (!donor) {
					break;
				}
				sendDown(donor);
			}
			callUp(callUpTarget);
		}
	}

	// c) Quality, one promotion per group per day to cap churn
	for (const group of Object.keys(FARM_ACTIVE_TARGETS) as Group[]) {
		const bestFarm = orderBy(
			farm.filter((p) => healthy(p) && getGroup(p) === group),
			"value",
			"desc",
		)[0];
		if (!bestFarm) {
			continue;
		}

		const groupActives = orderBy(
			active.filter((p) => healthy(p) && getGroup(p) === group),
			"value",
			"asc",
		);
		const worstActive = groupActives[0];

		if (
			worstActive &&
			bestFarm.value >= worstActive.value + FARM_PROMOTE_MARGIN
		) {
			if (active.length < maxRosterSize) {
				callUp(bestFarm);
			} else if (canSendDown(worstActive)) {
				// Same-group swap keeps the group counts unchanged
				sendDown(worstActive);
				callUp(bestFarm);
			}
		}
	}

	for (const pid of movedPids) {
		const p = players.find((p2) => p2.pid === pid)!;
		await idb.cache.players.put(p);
	}

	return movedPids;
};

// Run farm management for every AI team (same user-team exclusion as checkRosterSizes). Used from the daily loop in the playoffs (checkRosterSizes doesn't run there) and from the preseason.
export const manageFarmAll = async () => {
	if (!farmEnabled()) {
		return;
	}

	const teams = await idb.cache.teams.getAll();
	for (const t of teams) {
		if (t.disabled) {
			continue;
		}

		const userTeamAndActive =
			g.get("userTids").includes(t.tid) &&
			!local.autoPlayUntil &&
			!g.get("spectator");
		if (userTeamAndActive) {
			continue;
		}

		const movedPids = await manageFarmTeam(t.tid);
		if (movedPids.length > 0) {
			await rosterAutoSort(t.tid);
		}
	}
};
