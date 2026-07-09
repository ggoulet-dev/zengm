import { isSport } from "../../../common/sportFunctions.ts";
import type { Player, PlayerInjury } from "../../../common/types.ts";

// Hockey supplemental discipline: major penalties (from GameSim's majorPenalties output) can draw a
// suspension, implemented as a fake injury so the player sits, shows in injury views, and is excluded
// from lineups with no extra plumbing. Tuning target: roughly 25-60 suspensions per league season.
// Measured sim rates (400-game sample, default rosters): ~0.65 fighting majors and ~0.045 other
// majors per game, so per 1230-game season the expected suspensions are about
// 800 * FIGHTING + 37 * SEVERE + 15 * OTHER ~= 26 with the values below.
export const SUSPENSION_INJURY_TYPE = "Suspension";

// Probability that a major penalty results in a suspension, by category
export const SUSPENSION_PROB_SEVERE = 0.25; // Head shots and dangerous hits, see SEVERE_MAJOR_PENALTIES
export const SUSPENSION_PROB_OTHER_MAJOR = 0.08; // Any other non-fight major
export const SUSPENSION_PROB_FIGHTING = 0.02; // Fights almost never draw supplemental discipline (instigator rules etc), but they are so common they still produce most suspensions

export const SEVERE_MAJOR_PENALTIES = new Set([
	"illegal check to the head",
	"boarding",
	"checking from behind",
]);

// Suspension lengths: mostly 1-3 games, occasionally 4-8
export const SUSPENSION_PROB_LONG = 0.15;
export const SUSPENSION_GAMES_SHORT: [number, number] = [1, 3];
export const SUSPENSION_GAMES_LONG: [number, number] = [4, 8];

export const getSuspensionProb = (penaltyName: string) => {
	if (penaltyName === "fighting") {
		return SUSPENSION_PROB_FIGHTING;
	}

	if (SEVERE_MAJOR_PENALTIES.has(penaltyName)) {
		return SUSPENSION_PROB_SEVERE;
	}

	return SUSPENSION_PROB_OTHER_MAJOR;
};

// Returns the number of games suspended, or undefined for no suspension. random is injectable for tests.
export const rollSuspensionGames = (
	penaltyName: string,
	random: () => number = Math.random,
): number | undefined => {
	if (random() >= getSuspensionProb(penaltyName)) {
		return undefined;
	}

	const [min, max] =
		random() < SUSPENSION_PROB_LONG
			? SUSPENSION_GAMES_LONG
			: SUSPENSION_GAMES_SHORT;

	return min + Math.floor(random() * (max - min + 1));
};

// Suspensions can never be played through, so they zero out the playThroughInjuries threshold
export const getEffectivePlayThroughInjuries = (
	injury: PlayerInjury,
	playThroughInjuries: number,
) => {
	if (isSport("hockey") && injury.type === SUSPENSION_INJURY_TYPE) {
		return 0;
	}

	return playThroughInjuries;
};

// Mutates the box score player (p) and the cached player (p2). If a real injury from the same game
// (doInjury runs first) keeps the player out for the whole suspension anyway, it stays as the active
// injury and the suspension is served concurrently. There is never a ratings decline from a
// suspension. Returns true if the suspension became the active injury.
export const applySuspension = (
	p: {
		injury: PlayerInjury & { playingThrough?: boolean; newThisGame?: boolean };
		injuryAtStart?: PlayerInjury;
	},
	p2: Pick<Player, "injury" | "injuries">,
	gamesSuspended: number,
	season: number,
	playThroughInjuries: number,
	score: number = 0,
) => {
	if (!p2.injuries) {
		p2.injuries = [];
	}

	p2.injuries.push({
		season,
		games: gamesSuspended,
		type: SUSPENSION_INJURY_TYPE,
	});

	// +1 because the end-of-day injury countdown in play.ts runs after this, on the same day the suspension is assessed - without it, a player suspended N games would only sit N-1
	const gamesRemaining = gamesSuspended + 1;

	// A real injury takes precedence only if it actually sidelines the player for every suspended
	// game: the injury countdown must stay above the team's play-through cutoff until the suspension
	// is fully served. Otherwise the player would play through the injury and never serve the
	// suspension, so it must become the active injury, covering both durations.
	if (p2.injury.gamesRemaining - gamesSuspended > playThroughInjuries) {
		return false;
	}

	// So it gets written to box score... save the old injury (if playing through injury), like doInjury
	if (p.injury.playingThrough) {
		p.injuryAtStart = {
			type: p.injury.type,
			gamesRemaining: p.injury.gamesRemaining,
		};
	}

	// When taking over from a longer (but playable-through) injury, keep the longer countdown so the
	// injury is not shortened - the player serves both
	const combinedGamesRemaining = Math.max(
		gamesRemaining,
		p2.injury.gamesRemaining,
	);

	p2.injury = {
		type: SUSPENSION_INJURY_TYPE,
		gamesRemaining: combinedGamesRemaining,
		score,
	};
	p.injury = {
		type: SUSPENSION_INJURY_TYPE,
		gamesRemaining: combinedGamesRemaining,
		newThisGame: true,
	};

	return true;
};
