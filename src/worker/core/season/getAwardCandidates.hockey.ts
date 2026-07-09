import { getPlayers, getTopPlayers } from "./awards.ts";
import {
	dpoyScore,
	dfoyFilter,
	mvpScore,
	goyScore,
	royFilter,
	royScore,
} from "./doAwards.hockey.ts";

const getAwardCandidates = async (season: number) => {
	const players = await getPlayers(season);

	const awardCandidates = [
		{
			name: "Hart Memorial Trophy",
			players: getTopPlayers(
				{
					amount: 10,
					score: mvpScore,
				},
				players,
			),
			stats: ["keyStats", "ps"],
		},
		{
			name: "Norris Trophy",
			players: getTopPlayers(
				{
					amount: 10,
					filter: (p) => p.pos === "D",
					score: dpoyScore,
				},
				players,
			),
			stats: ["tk", "hit", "dps"],
		},
		{
			name: "Selke Trophy",
			players: getTopPlayers(
				{
					amount: 10,
					filter: dfoyFilter,
					score: dpoyScore,
				},
				players,
			),
			stats: ["tk", "hit", "dps"],
		},
		{
			name: "Vezina Trophy",
			players: getTopPlayers(
				{
					amount: 10,
					score: goyScore,
				},
				players,
			),
			stats: ["gpGoalie", "gaa", "svPct", "gps"],
		},
		{
			name: "Calder Memorial Trophy",
			players: getTopPlayers(
				{
					amount: 10,
					filter: royFilter,
					score: royScore,
				},
				players,
			),
			stats: ["keyStats", "ps"],
		},
	];

	return awardCandidates;
};

export default getAwardCandidates;
