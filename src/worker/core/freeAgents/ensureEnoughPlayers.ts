import { idb } from "../../db/index.ts";
import { PLAYER } from "../../../common/constants.ts";
import { g } from "../../util/index.ts";
import { player } from "../index.ts";
import { getAiRosterTarget } from "./getBest.ts";
import { isOnFarm } from "../team/farm.hockey.ts";

// Ensure enough players, in case there was some huge expansion draft
const ensureEnoughPlayers = async () => {
	// Farm players don't count toward the league's supply of playable bodies - counting hoarded prospects would starve the free-agent pool
	const players = (
		await idb.cache.players.indexGetAll("playersByTid", [
			PLAYER.FREE_AGENT,
			Infinity,
		])
	).filter((p) => !isOnFarm(p));

	// Base the target on the roster size AI teams actually maintain, not maxRosterSize - in leagues where maxRosterSize is a contracts limit (like 50 in NHL leagues), scaling with it floods the league with sub-replacement free agents
	const target =
		g.get("numActiveTeams") *
		(Math.min(g.get("maxRosterSize"), getAiRosterTarget() + 2) + 1);

	if (players.length < target) {
		const numToAdd = target - players.length;
		for (let i = 0; i < numToAdd; i++) {
			await player.genRandomFreeAgent();
		}
	}
};

export default ensureEnoughPlayers;
