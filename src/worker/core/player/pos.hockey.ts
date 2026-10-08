import ovr from "./ovr.hockey.ts";
import type { PlayerRatings } from "../../../common/types.hockey.ts";
import { POSITIONS } from "../../../common/constants.ts";

// F/D/G conversions are exceptional in hockey, so a player only floats between C and W
const positionGroup = (pos: string) => (pos === "D" || pos === "G" ? pos : "F");

export const samePositionGroup = (pos: string, current: string | undefined) =>
	current === undefined || positionGroup(pos) === positionGroup(current);

const pos = (ratings: PlayerRatings): string => {
	let best = POSITIONS[0];
	let max = -Infinity;

	for (const position of POSITIONS) {
		if (!samePositionGroup(position, ratings.pos)) {
			continue;
		}
		const value = ovr(ratings, position);
		if (value > max) {
			max = value;
			best = position;
		}
	}

	return best;
};

export default pos;
