import { idb } from "../../db/index.ts";
import { isOnFarm } from "./farm.hockey.ts";
import genDepth from "./genDepth.hockey.ts";

const rosterAutoSort = async (
	tid: number,
	onlyNewPlayers?: boolean,
	pos?: "F" | "D" | "G",
) => {
	const t = await idb.cache.teams.get(tid);
	if (!t) {
		throw new Error("Invalid tid");
	}

	const playersFromCache = await idb.cache.players.indexGetAll(
		"playersByTid",
		tid,
	);

	// The depth chart only contains active-roster players. Also strip farm pids from the stored depth so the onlyNewPlayers path can't keep a just-sent-down player in a line.
	const farmPids = new Set(
		playersFromCache.filter((p) => isOnFarm(p)).map((p) => p.pid),
	);
	const activePlayers = playersFromCache.filter((p) => !isOnFarm(p));

	const depth = t.depth as {
		F: number[];
		D: number[];
		G: number[];
	};
	if (farmPids.size > 0 && depth) {
		for (const key of ["F", "D", "G"] as const) {
			if (depth[key]) {
				depth[key] = depth[key].filter((pid) => !farmPids.has(pid));
			}
		}
	}

	t.depth = await genDepth(activePlayers, depth, onlyNewPlayers, pos);

	await idb.cache.teams.put(t);
};

export default rosterAutoSort;
