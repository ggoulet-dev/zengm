import { g, helpers } from "../../util/index.ts";
import { PHASE } from "../../../common/constants.ts";
import {
	NUM_LINES,
	NUM_PLAYERS_PER_LINE,
	POSITIONS,
} from "../../../common/constants.hockey.ts";
import getPlayers from "./getPlayers.ts";
import type { Position } from "../../../common/types.hockey.ts";
import type {
	CompositeRating,
	PlayerGameSim,
	PlayersOnIce,
	TeamGameSim,
} from "./types.ts";
import getCompositeFactor from "./getCompositeFactor.ts";
import {
	fightPenalty,
	penalties,
	penaltyTypes,
} from "../GameSim.hockey/penalties.ts";
import PenaltyBox from "./PenaltyBox.ts";
import getInjuryRate from "../GameSim.basketball/getInjuryRate.ts";
import GameSimBase from "../GameSim/GameSimBase.ts";
import { orderBy, range } from "../../../common/utils.ts";
import { getStartingAndBackupGoalies } from "./getStartingAndBackupGoalies.ts";
import type { TeamNum } from "../../../common/types.ts";
import PlayByPlayLogger from "./PlayByPlayLogger.ts";
import { choice } from "../../../common/random.ts";

const teamNums: [TeamNum, TeamNum] = [0, 1];

const GOALS = new Set(["evG", "ppG", "shG"]);

// NHL regular season overtime has been 3-on-3 since 2015, which opens up the ice. Added to the shot quality roll r (higher r = better for the shooter), tuned so roughly 65-75% of regular season overtimes end before the shootout, like in the NHL.
const THREE_ON_THREE_SHOT_BOOST = 0.06;

// In 3-on-3 overtime, coaches send their best offensive skaters rather than rolling regular lines. Pool sizes control how many of the top forwards/defensemen rotate through the overtime ice time.
const THREE_ON_THREE_POOL_SIZE = {
	F: 5,
	D: 3,
};

// Fights are rolled after hits, scaled by both players' enforcer rating, the score margin (lopsided games fight more), elapsed game time (frustration builds late), and the fightFactor game attribute. probPerHit is tuned against the sim's hit rate so the league averages ~0.3-0.4 fights/game, matching the NHL's own real-data rate of 449 fights per 1230-game season (see fightPenalty in penalties.ts). With real NHL rosters the engine produces ~22 hits/team/game (~44/game), so probPerHit must be far lower than a generated-roster harness (which saw only ~13 hits/game) implied - otherwise PIM doubles from runaway fighting.
export const FIGHT = {
	probPerHit: 0.006,

	// marginFactor = 1 + probPerGoalDifferential * min(margin, maxGoalDifferential)
	probPerGoalDifferential: 0.25,
	maxGoalDifferential: 4,

	// timeFactor ranges from 1 - probLateGame / 2 (opening faceoff) to 1 + probLateGame / 2 (end of regulation), averaging 1
	probLateGame: 0.5,
};

// Mid-game goalie hook: the coach pulls a struggling starter for the backup, based on the on-ice goalie's live stat line. Tuned so starters get hooked in roughly 3-6% of team-games league-wide (a handful of relief appearances per NHL team per season).
export const GOALIE_HOOK = {
	// Hooked at this many goals against, regardless of save fraction. Thresholds are
	// one lower than a naive count because the scoring recalibration dropped goals to
	// ~3.1/team/game; at the old 6/5/4 a struggling starter almost never reached the
	// hook in the new, lower-scoring environment.
	gaAnytime: 5,

	// Hooked earlier if the save fraction is bad
	gaPoorSv: 4,
	poorSvFraction: 0.85,

	// Quick hook for a goalie shelled in the 1st period
	gaFirstPeriod: 3,
	firstPeriodSvFraction: 0.75,
};

// === Shot funnel calibration (tuned against the real NHL roster, not generated players) ===
// doShot rolls a SINGLE uniform r per attempt and gates it sequentially:
//   r < probBlock                         -> blocked shot
//   probBlock <= r < missThreshold        -> missed the net
//   missThreshold <= r < savePercentage   -> shot on goal, saved
//   r >= savePercentage                   -> goal
// So the constants below carve [0,1] into NHL-like slices: ~26% blocked, ~23% miss the net,
// ~51% on goal, ~10% of shots-on-goal score (=> ~3.0 goals, ~29 SOG, .901 SV%, 10% shooting).
//
// probBlock = SHOT_BLOCK_BASE + SHOT_BLOCK_RANGE * opponent blocking composite.
const SHOT_BLOCK_BASE = 0.05;
const SHOT_BLOCK_RANGE = 0.34;
//
// missThreshold = SHOT_MISS_BASE - SHOT_MISS_SCORING * shooter scoring composite (fatigue-adjusted).
// The old formula (0.75 - scoring) collapsed below probBlock for any skilled shooter, so almost
// nothing missed the net and SOG ran ~40/game; a lower base with a gentler scoring slope keeps a
// realistic ~23% of attempts wide/over the net while still rewarding snipers with fewer misses.
const SHOT_MISS_BASE = 0.68;
const SHOT_MISS_SCORING = 0.35;
//
// savePercentage = GOALIE_SAVE_BASE + shotQualityComponent + glk composite * GOALIE_SAVE_GLK.
// The old 0.947 + glk*0.07 saturated at the 0.99 cap for every real NHL goalie (glk 70-93),
// so goalies were superhuman (league .958, GAA ~1.1). A lower base de-saturates the formula so
// the goalkeeping rating is discriminating again across the real NHL talent range:
//   glk 60 -> ~.886, glk 78 (typical starter) -> ~.901, glk 93 (elite) -> ~.918.
const GOALIE_SAVE_BASE = 0.917;
const GOALIE_SAVE_GLK = 0.062;

// Role-anchored shooter selection. The shooter used to be picked purely by scoring composite
// across all skaters on the ice, which let this roster's many elite offensive defensemen take
// ~36% of all shots - well above the NHL's ~27% D share. We instead decide forward-vs-defense by
// a fixed role split first, then pick the shooter within that group by scoring. This keeps the
// shot distribution realistic no matter how offensively gifted a team's blue line is.
const SHOOTER_D_SHARE = 0.27;

// Even at a realistic shot share, defensemen shoot from distance (point shots), which are
// lower-danger than a forward's chance from the slot. This small bonus to the goalie's save odds
// on a defenseman's own shot keeps offensive D piling up assists from the point while scoring
// realistically few of their own goals (the single-season NHL D goal record is ~25; without any
// correction this roster produced 50-goal defensemen).
const SHOOTER_D_SAVE_BONUS = 0.03;

// NHL "score effects": a trailing team presses for offense while a leading team sits back to protect
// the lead. The swing grows with the score margin and as the game gets late, mirroring the real
// surge in the trailing team's shot share in the third period. It is applied by nudging the
// per-possession "nothing happens" rate (BASE_NOTHING): the offense fizzles fewer possessions when
// behind and more when ahead. Because every lead is someone else's deficit, league-wide shot and
// goal totals stay ~unchanged; what changes is game feel - more comebacks, more late pushes, and a
// few more games reaching overtime.
const BASE_NOTHING = 0.05;
const SCORE_EFFECTS = {
	// Largest change to the per-possession nothing rate (at max margin, end of regulation)
	maxNothingSwing: 0.04,

	// Score margin (goals) at which the effect saturates
	maxMargin: 3,
};

/**
 * Convert energy into fatigue, which can be multiplied by a rating to get a fatigue-adjusted value.
 *
 * @param {number} energy A player's energy level, from 0 to 1 (0 = lots of energy, 1 = none).
 * @return {number} Fatigue, from 0 to 1 (0 = lots of fatigue, 1 = none).
 */
const fatigue = (energy: number): number => {
	energy += 0.05;

	if (energy > 1) {
		energy = 1;
	}

	return energy;
};

type TeamLines = {
	F: PlayerGameSim[][];
	D: PlayerGameSim[][];
	G: PlayerGameSim[][];
};

type TeamCurrentLine = {
	F: number;
	D: number;
	G: number;
};
class GameSim extends GameSimBase {
	team: [TeamGameSim, TeamGameSim];

	playersOnIce: [PlayersOnIce, PlayersOnIce];

	clock: number;

	numPeriods: number;

	o: TeamNum;

	d: TeamNum;

	playByPlay: PlayByPlayLogger;

	minutesSinceLineChange: [
		{
			F: number;
			D: number;
		},
		{
			F: number;
			D: number;
		},
	];

	// @ts-expect-error
	lines: [TeamLines, TeamLines];

	currentLine: [TeamCurrentLine, TeamCurrentLine];

	penaltyBox: PenaltyBox;

	synergyFactor: number;

	pulledGoalie: [boolean, boolean];

	// Backup dressed for each team, so a struggling starter can be hooked mid-game
	backupGoalies: [PlayerGameSim | undefined, PlayerGameSim | undefined] = [
		undefined,
		undefined,
	];

	// A goalie hook happens at most once per game per team, and the hooked starter does not return
	hookedGoalie: [boolean, boolean] = [false, false];

	// Regular season overtime is played 3-on-3 (NHL rule since 2015); playoffs stay 5-on-5
	threeOnThree = false;

	// Major penalties assessed this game (fights included). Returned from run() so writePlayerStats can roll supplemental discipline (suspensions) - only "pim" is in stats, so majors must flow out of GameSim directly.
	majorPenalties: { pid: number; name: string }[] = [];

	// Goalies in net (for both teams, by team index) when each goal was scored, in order. Returned from run() so writePlayerStats can assign the goalie decisions by the NHL rule (W/L go to the goalies of record for the game-winning goal), which matters after a mid-game goalie hook. undefined = empty net.
	goaliesAtGoals: {
		t: TeamNum;
		goaliePids: [number | undefined, number | undefined];
	}[] = [];

	// Goalies in net for the shootout, if there was one - the shootout decision goes to them
	shootoutGoaliePids: [number, number] | undefined;

	// OT winners and shootout deciders. writeGameStats appends the score/opponent and a period to text, so text must include neither
	clutchPlays: {
		text: string;
		showNotification: boolean;
		pids: [number];
		tids: [number];
	}[] = [];

	constructor({
		gid,
		day,
		teams,
		doPlayByPlay,
		homeCourtFactor,
		allStarGame,
		baseInjuryRate,
		neutralSite,
	}: {
		gid: number;
		day?: number;
		teams: [TeamGameSim, TeamGameSim];
		doPlayByPlay: boolean;
		homeCourtFactor: number;
		allStarGame: boolean;
		baseInjuryRate: number;
		neutralSite: boolean;
	}) {
		super({
			gid,
			day,
			allStarGame,
			baseInjuryRate,
			neutralSite,
		});

		this.playByPlay = new PlayByPlayLogger(doPlayByPlay);
		this.team = teams; // If a team plays twice in a day, this needs to be a deep copy

		this.synergyFactor = 1;

		this.playersOnIce = [
			{
				C: [],
				W: [],
				D: [],
				G: [],
			},
			{
				C: [],
				W: [],
				D: [],
				G: [],
			},
		];

		this.setLines();

		this.currentLine = [
			{
				F: 0,
				D: 0,
				G: 0,
			},
			{
				F: 0,
				D: 0,
				G: 0,
			},
		];

		// Record "gs" stat for starters
		this.o = 0;
		this.d = 1;
		this.updatePlayersOnIce({ type: "starters" });

		this.clock = g.get("quarterLength"); // Game clock, in minutes
		this.numPeriods = g.get("numPeriods");

		if (!neutralSite) {
			this.homeCourtAdvantage(homeCourtFactor);
		}

		this.minutesSinceLineChange = [
			{
				F: 0,
				D: 0,
			},
			{
				F: 0,
				D: 0,
			},
		];

		this.penaltyBox = new PenaltyBox(
			({ t, p, minutesAgo, ppo, coincidental }) => {
				this.playByPlay.logEvent({
					type: "penaltyOver",
					clock: this.clock + minutesAgo,
					t,
					names: [p.name],
					penaltyPID: p.id,
				});

				if (ppo > 0) {
					const t2 = t === 0 ? 1 : 0;
					this.recordStat(t2, undefined, "ppo", 1);
				}

				if (coincidental) {
					// On-ice strength was never affected, so nobody steps out of the box onto the ice - the fighter rejoins at his line's next shift
					return;
				}

				this.updatePlayersOnIce({ type: "penaltyOver", p, t });
			},
		);

		this.pulledGoalie = [false, false];
	}

	// Call this at beginning of game or after injuries
	setLines() {
		this.lines = [
			{
				F: [],
				D: [],
			},
			{
				F: [],
				D: [],
			},
		] as any;

		for (const t of teamNums) {
			// First, make sure players listed in the main lines for G/D/F are reserved and not used as injury replacements
			const inDepthChart = new Set();
			for (const pos of ["G", "D", "F"] as const) {
				const numInDepthChart = NUM_LINES[pos] * NUM_PLAYERS_PER_LINE[pos];
				for (let i = 0; i < numInDepthChart; i++) {
					inDepthChart.add(this.team[t].depth[pos][i]!.id);
				}
			}

			const usedPlayerIDs = new Set();

			// Then, assign players to lines, moving up lower players to replace injured ones
			for (const pos of ["G", "D"] as const) {
				let players = this.team[t].depth[pos];

				// Handle rest days for goalie
				if (pos === "G") {
					// After a mid-game hook, the relief goalie (still in backupGoalies) stays in net even if injuries force new lines - the hooked starter does not return
					const reliefGoalie = this.hookedGoalie[t]
						? this.backupGoalies[t]
						: undefined;
					if (reliefGoalie && !reliefGoalie.injured) {
						players = [
							reliefGoalie,
							...players.filter((p) => p !== reliefGoalie),
						];
					} else {
						const [starter, backup] = getStartingAndBackupGoalies(players);
						players = [
							starter,
							backup,
							...players.filter((p) => p !== starter && p !== backup),
						];
					}
				}

				const numInDepthChart = NUM_LINES[pos] * NUM_PLAYERS_PER_LINE[pos];

				const lines: PlayerGameSim[][] = range(NUM_LINES[pos]).map(() => []);
				let ind = 0;
				for (const [i, p] of players.entries()) {
					if (p.injured || usedPlayerIDs.has(p.id)) {
						continue;
					}

					if (i < numInDepthChart || !inDepthChart.has(p.id)) {
						if (lines[ind]!.length === NUM_PLAYERS_PER_LINE[pos]) {
							ind += 1;
							if (ind === NUM_LINES[pos]) {
								break;
							}
						}
						if (lines[ind]!.length < NUM_PLAYERS_PER_LINE[pos]) {
							lines[ind]!.push(p);
							usedPlayerIDs.add(p.id);
						}
					}
				}

				// If too injured to fill one line, poach players from inDepthChart
				const line = lines[0]!;
				if (line.length < NUM_PLAYERS_PER_LINE[pos]) {
					for (const p of players) {
						if (p.injured || usedPlayerIDs.has(p.id)) {
							continue;
						}

						line.push(p);
						usedPlayerIDs.add(p.id);
						if (line.length === NUM_PLAYERS_PER_LINE[pos]) {
							break;
						}
					}
				}

				this.lines[t][pos] = lines;

				// After a hook, backupGoalies keeps pointing at the relief goalie now in net
				if (pos === "G" && !this.hookedGoalie[t]) {
					// Stash the backup ordering from getStartingAndBackupGoalies so checkGoalieHook can swap him in mid-game. depth.G is the whole roster sorted by goalie rating, so require a natural goalie - otherwise a skater could end up in net when only one real goalie is healthy. No healthy natural backup means no mid-game hook.
					const dressedGoalie = lines[0]![0];
					this.backupGoalies[t] = players.find(
						(p) =>
							p.pos === "G" &&
							p !== dressedGoalie &&
							!p.injured &&
							!usedPlayerIDs.has(p.id),
					);
				}
			}

			// Special case for forwards (no need to check inDepthChart anymore, since other positions are already done)
			{
				const pos = "F";
				const players = this.team[t].depth[pos];

				const numInDepthChart = NUM_LINES[pos] * NUM_PLAYERS_PER_LINE[pos];

				const centers = [];
				const wings = [];
				const notInDefinedLines = [];

				for (const [i, p] of players.entries()) {
					if (p.injured || usedPlayerIDs.has(p.id)) {
						continue;
					}

					// For the 4 defined lines, first of the 3 players is the center
					if (i >= numInDepthChart) {
						notInDefinedLines.push(p);
					} else if (i % NUM_PLAYERS_PER_LINE[pos] === 0) {
						centers.push(p);
					} else {
						wings.push(p);
					}
				}

				// This ensures that any subs from the bench will be taken based on how good they are as a C/W (previously, it'd just take the best ovr player)
				centers.push(...orderBy(notInDefinedLines, (p) => p.ovrs.C, "desc"));
				wings.push(...orderBy(notInDefinedLines, (p) => p.ovrs.W, "desc"));

				const lines: PlayerGameSim[][] = range(NUM_LINES[pos]).map(() => []);
				for (const line of lines) {
					let center = centers.shift();
					while (center === undefined || usedPlayerIDs.has(center.id)) {
						center = centers.shift();
						if (center === undefined && wings.length > 0) {
							center = wings.shift();
						}

						if (centers.length === 0 && wings.length === 0) {
							break;
						}
					}

					let wing1 = wings.shift();
					while (
						wing1 === undefined ||
						usedPlayerIDs.has(wing1.id) ||
						wing1 === center
					) {
						wing1 = wings.shift();
						if (wing1 === undefined && centers.length > 0) {
							wing1 = centers.shift();
						}

						if (centers.length === 0 && wings.length === 0) {
							break;
						}
					}

					let wing2 = wings.shift();
					while (
						wing2 === undefined ||
						usedPlayerIDs.has(wing2.id) ||
						wing2 === center ||
						wing2 === wing1
					) {
						wing2 = wings.shift();
						if (wing2 === undefined && centers.length > 0) {
							wing2 = centers.shift();
						}

						if (centers.length === 0 && wings.length === 0) {
							break;
						}
					}

					if (center && wing1 && wing2) {
						line.push(center, wing1, wing2);
						usedPlayerIDs.add(center.id);
						usedPlayerIDs.add(wing1.id);
						usedPlayerIDs.add(wing2.id);
					}
				}

				this.lines[t][pos] = lines;
			}

			// Emergency check... do we need to use injured players to fill out the first line?
			for (const pos of ["G", "D", "F"] as const) {
				const players = this.team[t].depth[pos];

				const line = this.lines[t][pos][0]!;
				const numNeeded = NUM_PLAYERS_PER_LINE[pos];
				if (line.length < numNeeded) {
					for (const p of players) {
						if (usedPlayerIDs.has(p.id)) {
							continue;
						}

						line.push(p);
						usedPlayerIDs.add(p.id);
						if (line.length === numNeeded) {
							break;
						}
					}
				}
			}
		}
	}

	homeCourtAdvantage(homeCourtFactor: number) {
		const homeCourtModifier =
			homeCourtFactor *
			helpers.bound(1 + g.get("homeCourtAdvantage") / 100, 0.01, Infinity);

		for (const t of teamNums) {
			let factor;

			if (t === 0) {
				factor = homeCourtModifier; // Bonus for home team
			} else {
				factor = 1.0 / homeCourtModifier; // Penalty for away team
			}

			for (const p of this.team[t].player) {
				for (const r of Object.keys(p.compositeRating)) {
					if (r !== "endurance") {
						p.compositeRating[r] *= factor;
					}
				}
			}
		}
	}

	run() {
		// Simulate the game up to the end of regulation
		this.simRegulation();

		let numOvertimes = 0;
		while (
			this.team[0].stat.pts === this.team[1].stat.pts &&
			numOvertimes < this.maxOvertimes
		) {
			this.simOvertime();
			numOvertimes += 1;
		}

		this.doShootout();

		this.playByPlay.logEvent({
			type: "gameOver",
			clock: this.clock,
		});

		// Delete stuff that isn't needed before returning
		for (const t of teamNums) {
			delete this.team[t].compositeRating;
			// @ts-expect-error
			delete this.team[t].pace;

			for (const p of this.team[t].player) {
				// @ts-expect-error
				delete p.age;
				// @ts-expect-error
				delete p.valueNoPot;
				delete p.compositeRating;
				// @ts-expect-error
				delete p.ptModifier;
				delete p.stat.benchTime;
				delete p.stat.courtTime;
				delete p.stat.energy;
				delete p.numConsecutiveGamesG;
			}
		}

		const out = {
			gid: this.id,
			day: this.day,
			overtimes: this.overtimes,
			team: this.team,
			clutchPlays: this.clutchPlays,
			playByPlay: this.playByPlay.getPlayByPlay(this.team),
			neutralSite: this.neutralSite,
			scoringSummary: this.playByPlay.scoringSummary,
			majorPenalties: this.majorPenalties,
			goaliesAtGoals: this.goaliesAtGoals,
			shootoutGoaliePids: this.shootoutGoaliePids,
		};
		return out;
	}

	doShootoutShot(t: TeamNum, p: PlayerGameSim, goalie: PlayerGameSim) {
		// 50% to 100%
		const skaterProb = 0.5 + 0.5 * p.compositeRating.scoring;
		const goalieProb = 1 - 0.5 * goalie.compositeRating.goalkeeping;

		const probMake = skaterProb * goalieProb;

		const made = Math.random() < probMake;

		this.recordStat(t, undefined, "sAtt");

		this.playByPlay.logEvent({
			type: "shootoutTeam",
			clock: this.clock,
			t,
			names: [p.name],
		});

		if (made) {
			this.recordStat(t, undefined, "sPts");
		}

		this.playByPlay.logEvent({
			type: "shootoutShot",
			clock: this.clock,
			t,
			names: [p.name],
			goalieName: goalie.name,
			made,
			goalType: "pn",
			shotType: "penalty shot",
		});

		return made;
	}

	doShootout() {
		if (
			this.shootoutRounds <= 0 ||
			this.team[0].stat.pts !== this.team[1].stat.pts
		) {
			return;
		}

		this.shootout = true;
		this.clock = 1; // So fast-forward to end of period stops before the shootout
		this.team[0].stat.sPts = 0;
		this.team[0].stat.sAtt = 0;
		this.team[1].stat.sPts = 0;
		this.team[1].stat.sAtt = 0;

		const reversedTeamNums = [1, 0] as const;

		this.playByPlay.logEvent({
			type: "shootoutStart",
			rounds: this.shootoutRounds,
			clock: this.clock,
		});

		const skaters = teamNums.map((t) => {
			let eligible = this.team[t].depth.F.filter((p) => !p.injured);
			if (eligible.length === 0) {
				// Use injured players if there are no others
				eligible = this.team[t].depth.F;
			}

			return orderBy(eligible, (p) => p.compositeRating.scoring, "desc");
		}) as [PlayerGameSim[], PlayerGameSim[]];

		// goalies[t] is the goalie FACING team t's shooters, from the other team's lines
		const goalies = teamNums.map((t) => {
			return this.lines[t === 0 ? 1 : 0].G[0]![0]!;
		}) as [PlayerGameSim, PlayerGameSim];

		this.shootoutGoaliePids = [
			this.lines[0].G[0]![0]!.id,
			this.lines[1].G[0]![0]!.id,
		];

		const skatersIndex: [number, number] = [0, 0];

		const getNextSkater = (t: 0 | 1) => {
			const skater = skaters[t][skatersIndex[t] % skaters[t].length]!;
			skatersIndex[t] += 1;
			return skater;
		};

		// Scorers in order, to find the deciding goal after the shootout ends
		const scorers: [PlayerGameSim[], PlayerGameSim[]] = [[], []];

		SHOOTOUT_ROUNDS: for (let i = 0; i < this.shootoutRounds; i++) {
			for (const t of reversedTeamNums) {
				const p = getNextSkater(t);
				if (this.doShootoutShot(t, p, goalies[t])) {
					scorers[t].push(p);
				}

				if (
					this.shouldEndShootoutEarly(t, i, [
						this.team[0].stat.sPts,
						this.team[1].stat.sPts,
					])
				) {
					break SHOOTOUT_ROUNDS;
				}
			}
		}

		if (this.team[0].stat.sPts === this.team[1].stat.sPts) {
			this.playByPlay.logEvent({
				type: "shootoutTie",
				clock: this.clock,
			});

			while (this.team[0].stat.sPts === this.team[1].stat.sPts) {
				for (const t of reversedTeamNums) {
					const p = getNextSkater(t);
					if (this.doShootoutShot(t, p, goalies[t])) {
						scorers[t].push(p);
					}
				}
			}
		}

		const winner = this.team[0].stat.sPts > this.team[1].stat.sPts ? 0 : 1;
		const loser = winner === 0 ? 1 : 0;

		// Like the NHL's game-deciding goal: the winner's goal that exceeded the loser's final total. The winner always has at least sPts[loser] + 1 goals, so this index is valid
		const decidingScorer = scorers[winner][this.team[loser].stat.sPts]!;
		this.clutchPlays.push({
			text: `<a href="${helpers.leagueUrl(["player", decidingScorer.id])}">${
				decidingScorer.name
			}</a> scored the shootout-deciding goal`,
			showNotification: this.team[winner].id === g.get("userTid"),
			pids: [decidingScorer.id],
			tids: [this.team[winner].id],
		});
	}

	simRegulation() {
		let quarter = 1;

		while (true) {
			this.updatePlayersOnIce({ type: "newPeriod" });
			this.faceoff();

			while (this.clock > 0) {
				this.simPossession();
				this.advanceClock();
				if (this.clock > 0) {
					this.injuries();
					this.updatePlayersOnIce({ type: "normal" });
					this.checkPullGoalie(this.o);
					this.checkGoalieHook(0);
					this.checkGoalieHook(1);
				}
			}

			// A goal as the period expires can push the goalie past the hook thresholds with no clock left for the in-loop check, and next period the first period quick hook no longer applies - so check once more with the just-ended period's thresholds, unless the game is over
			if (
				quarter < this.numPeriods ||
				(this.team[0].stat.pts === this.team[1].stat.pts &&
					(this.maxOvertimes > 0 || this.shootoutRounds > 0))
			) {
				this.checkGoalieHook(0);
				this.checkGoalieHook(1);
			}

			quarter += 1;

			if (quarter > this.numPeriods) {
				break;
			}

			this.team[0].stat.ptsQtrs.push(0);
			this.team[1].stat.ptsQtrs.push(0);
			this.clock = g.get("quarterLength");
			this.minutesSinceLineChange[0].F = 0;
			this.minutesSinceLineChange[0].D = 0;
			this.minutesSinceLineChange[1].F = 0;
			this.minutesSinceLineChange[1].D = 0;
			this.playByPlay.logEvent({
				type: "quarter",
				clock: this.clock,
				quarter: this.team[0].stat.ptsQtrs.length,
			});
		}
	}

	simOvertime() {
		this.clock = this.getOvertimeLength();

		this.threeOnThree = g.get("phase") !== PHASE.PLAYOFFS;

		this.minutesSinceLineChange[0].F = 0;
		this.minutesSinceLineChange[0].D = 0;
		this.minutesSinceLineChange[1].F = 0;
		this.minutesSinceLineChange[1].D = 0;

		this.overtime = true;
		this.overtimes += 1;
		this.team[0].stat.ptsQtrs.push(0);
		this.team[1].stat.ptsQtrs.push(0);
		this.playByPlay.logEvent({
			type: "overtime",
			clock: this.clock,
			quarter: this.team[0].stat.ptsQtrs.length,
			threeOnThree: this.threeOnThree,
		});

		// No need to guard checkPullGoalie against 3-on-3 - in sudden death OT the score is always tied, and shouldPullGoalie additionally requires period === numPeriods, so the calls below can only put a goalie back in net

		this.checkPullGoalie(this.o);
		this.checkPullGoalie(this.d);

		this.updatePlayersOnIce({ type: "newPeriod" });
		this.faceoff();

		while (this.clock > 0) {
			this.simPossession();

			if (this.team[0].stat.pts !== this.team[1].stat.pts) {
				// Sudden death overtime
				break;
			}

			this.advanceClock();

			if (this.clock > 0) {
				this.injuries();
				this.updatePlayersOnIce({ type: "normal" });
			}
		}
	}

	possessionChange() {
		this.o = this.o === 1 ? 0 : 1;
		this.d = this.o === 1 ? 0 : 1;
	}

	isHit() {
		return (
			Math.random() <
			(this.allStarGame ? 0.1 : 1) *
				0.24 *
				(this.team[this.o].compositeRating.hitting +
					this.team[this.d].compositeRating.hitting) *
				g.get("hitFactor")
		);
	}

	// Returns true if the hit boiled over into a fight, which stops play
	doHit() {
		const t = choice(teamNums, (t) => this.team[t].compositeRating.hitting);
		const t2 = t === 0 ? 1 : 0;
		const hitter = this.pickPlayer(t, "enforcer", ["C", "W", "D"]);
		const target = this.pickPlayer(t2, undefined, ["C", "W", "D"]);

		this.recordStat(t2, target, "energy", -0.5);

		this.recordStat(t, hitter, "hit", 1);
		this.playByPlay.logEvent({
			type: "hit",
			clock: this.clock,
			t,
			names: [hitter.name, target.name],
		});

		if (this.checkFight(t, hitter, t2, target)) {
			return true;
		}

		this.injuries({
			type: "hit",
			hitter,
			target,
			t: t2,
		});

		return false;
	}

	checkFight(
		t: TeamNum,
		hitter: PlayerGameSim,
		t2: TeamNum,
		target: PlayerGameSim,
	) {
		// Fights basically never happen in overtime (and 3-on-3 makes them even less plausible). Goalies never fight here either - hitter/target are skaters by construction (pickPlayer with ["C", "W", "D"]).
		if (this.overtime || this.allStarGame) {
			return false;
		}

		const fightFactor = g.get("fightFactor");
		if (fightFactor <= 0) {
			return false;
		}

		const margin = Math.abs(this.team[0].stat.pts - this.team[1].stat.pts);
		const marginFactor =
			1 +
			FIGHT.probPerGoalDifferential *
				Math.min(margin, FIGHT.maxGoalDifferential);

		const period = this.team[0].stat.ptsQtrs.length;
		const periodLength = g.get("quarterLength");
		const fractionElapsed = helpers.bound(
			(period -
				1 +
				(periodLength > 0 ? (periodLength - this.clock) / periodLength : 0)) /
				this.numPeriods,
			0,
			1,
		);
		const timeFactor =
			1 - FIGHT.probLateGame / 2 + FIGHT.probLateGame * fractionElapsed;

		const prob =
			FIGHT.probPerHit *
			(hitter.compositeRating.enforcer + target.compositeRating.enforcer) *
			marginFactor *
			timeFactor *
			fightFactor;

		if (Math.random() >= prob) {
			return false;
		}

		this.doFight(t, hitter, t2, target);

		return true;
	}

	// NHL fights are coincidental majors: both fighters sit 5 minutes (with no early release on goals) but neither team loses a skater on the ice
	doFight(
		t: TeamNum,
		hitter: PlayerGameSim,
		t2: TeamNum,
		target: PlayerGameSim,
	) {
		const winner = choice(
			[hitter, target],
			(p) => 0.1 + p.compositeRating.enforcer + p.compositeRating.power,
		);
		const loser = winner === hitter ? target : hitter;

		const fighters: [TeamNum, PlayerGameSim][] = [
			[t, hitter],
			[t2, target],
		];
		for (const [tFighter, p] of fighters) {
			this.penaltyBox.add(tFighter, p, fightPenalty, true);
			this.recordStat(
				tFighter,
				p,
				"pim",
				penaltyTypes[fightPenalty.type].minutes,
			);
			this.majorPenalties.push({
				pid: p.id,
				name: fightPenalty.name,
			});
		}

		this.playByPlay.logEvent({
			type: "fight",
			clock: this.clock,
			t: winner === hitter ? t : t2,
			names: [winner.name, loser.name],
			pids: [winner.id, loser.id],
		});

		// Actually remove both fighters from the ice. Coincidental majors are excluded from PenaltyBox.count, so the line change below ices a full complement for both teams.
		this.updatePlayersOnIce({ type: "penalty" });
	}

	isGiveaway() {
		const { powerPlayTeam } = this.penaltyBox.getPowerPlayTeam();

		let baseOdds = 0.1;
		if (powerPlayTeam === this.o) {
			baseOdds /= 2;
		} else if (powerPlayTeam === this.d) {
			baseOdds *= 2;
		}
		return (
			Math.random() <
			((baseOdds * this.team[this.d].compositeRating.takeaway) /
				this.team[this.o].compositeRating.puckControl) *
				g.get("giveawayFactor")
		);
	}

	isTakeaway() {
		const { powerPlayTeam } = this.penaltyBox.getPowerPlayTeam();

		let baseOdds = 0.1;
		if (powerPlayTeam === this.o) {
			baseOdds /= 2;
		} else if (powerPlayTeam === this.d) {
			baseOdds *= 2;
		}
		return (
			Math.random() <
			((baseOdds * this.team[this.d].compositeRating.takeaway) /
				this.team[this.o].compositeRating.puckControl) *
				g.get("takeawayFactor")
		);
	}

	isNothing() {
		let prob = BASE_NOTHING;

		// Score effects: tilt the offense's productivity by the score margin, weighted by how late it
		// is. No effect when tied or in the shootout.
		const margin = this.team[this.o].stat.pts - this.team[this.d].stat.pts;
		if (!this.shootout && margin !== 0) {
			const period = this.team[0].stat.ptsQtrs.length;
			const periodLength = g.get("quarterLength");
			const fractionElapsed = helpers.bound(
				(period -
					1 +
					(periodLength > 0 ? (periodLength - this.clock) / periodLength : 0)) /
					this.numPeriods,
				0,
				1,
			);
			const marginFactor =
				Math.min(Math.abs(margin), SCORE_EFFECTS.maxMargin) /
				SCORE_EFFECTS.maxMargin;
			const swing =
				SCORE_EFFECTS.maxNothingSwing * marginFactor * fractionElapsed;

			// Leading offense sits back (more fizzled possessions); trailing offense presses (fewer)
			prob += margin > 0 ? swing : -swing;
		}

		return Math.random() < prob;
	}

	doGiveaway() {
		const p = this.pickPlayer(this.o, undefined, ["C", "W", "D"]);

		this.recordStat(this.o, p, "gv", 1);
		this.playByPlay.logEvent({
			type: "gv",
			clock: this.clock,
			t: this.o,
			names: [p.name],
		});
		this.possessionChange();
	}

	doTakeaway() {
		const p = this.pickPlayer(this.d, "grinder", ["C", "W", "D"]);

		this.recordStat(this.d, p, "tk", 1);
		this.playByPlay.logEvent({
			type: "tk",
			clock: this.clock,
			t: this.d,
			names: [p.name],
		});
		this.possessionChange();
	}

	advanceClock(special?: "rebound") {
		// 1 to N seconds, or less if it's a rebound
		const maxLength = special === "rebound" ? 0.05 : 0.235;

		let dt = Math.random() * (maxLength - 0.017) + 0.017;
		dt /= g.get("pace");

		// Faster pace (more shots) in ASG
		if (this.allStarGame) {
			dt /= 2;
		}

		if (this.clock - dt < 0) {
			dt = this.clock;
		}

		// If advancing dt will pass by someone being released from the penalty box, break it into multiple steps so updatePlayingTime can be correct about ppMin and shMin
		const dts = this.penaltyBox.splitUpAdvanceClock(dt);
		for (const partial of dts) {
			this.updatePlayingTime(partial);
			this.clock -= partial;
			this.penaltyBox.advanceClock(partial);
		}

		this.minutesSinceLineChange[0].F += dt;
		this.minutesSinceLineChange[0].D += dt;
		this.minutesSinceLineChange[1].F += dt;
		this.minutesSinceLineChange[1].D += dt;

		if (this.clock <= 0) {
			this.clock = 0;
			return true;
		}

		return false;
	}

	doShot(special?: "rebound") {
		// Decide whether this shot comes off a defenseman's stick or a forward's before picking
		// the individual shooter, so the F/D shot split stays NHL-realistic (see SHOOTER_D_SHARE).
		const shooterPositions: Position[] =
			Math.random() < SHOOTER_D_SHARE ? ["D"] : ["C", "W"];
		const shooter =
			this.pickPlayer(this.o, "scoring", shooterPositions, 5) ??
			this.pickPlayer(this.o, "scoring", ["C", "W", "D"], 5);

		const type: "slapshot" | "wristshot" | "shot" | "reboundShot" =
			special === "rebound"
				? "reboundShot"
				: choice(["slapshot", "wristshot", "shot"], [0.25, 0.5, 0.25]);

		this.recordStat(this.o, shooter, "tsa");
		this.playByPlay.logEvent({
			type,
			clock: this.clock,
			t: this.o,
			names: [shooter.name],
		});

		const { powerPlayTeam, strengthDifference } =
			this.penaltyBox.getPowerPlayTeam();
		let strengthType: "ev" | "sh" | "pp" = "ev";
		let totalStrengthDifference = 0;
		if (powerPlayTeam === this.d) {
			strengthType = "sh";
			totalStrengthDifference -= strengthDifference;
		} else if (powerPlayTeam === this.o) {
			strengthType = "pp";
			totalStrengthDifference += strengthDifference;
		}

		if (this.pulledGoalie[this.o]) {
			totalStrengthDifference += 1;
		}
		if (this.pulledGoalie[this.d]) {
			totalStrengthDifference -= 1;
		}

		let r = Math.random();

		// Tone down pulled goalie situations
		const pulledGoalieFactor = this.pulledGoalie[this.d] ? 0.5 : 1;

		// Power play adjusts odds of a miss
		if (totalStrengthDifference > 1) {
			// 5-on-3: big boost, but the old +0.2 over-converted (PP% ran ~34%) once the save
			// formula was de-saturated, so it is dialed back to land NHL ~20-22% power-play %.
			r += 0.12 * pulledGoalieFactor;
		} else if (totalStrengthDifference === 1) {
			// Standard 5-on-4 power play.
			r += 0.05 * pulledGoalieFactor;
		} else if (totalStrengthDifference === -1) {
			r -= 0.025 * pulledGoalieFactor;
		} else if (totalStrengthDifference < -1) {
			r -= 0.5 * pulledGoalieFactor;
		}

		// Open ice at 3-on-3 makes every rush more dangerous
		if (this.threeOnThree) {
			r += THREE_ON_THREE_SHOT_BOOST;
		}

		let probBlock =
			(SHOT_BLOCK_BASE +
				SHOT_BLOCK_RANGE * this.team[this.d].compositeRating.blocking) *
			g.get("blockFactor");
		if (this.allStarGame) {
			probBlock /= 2;
		}

		if (r < probBlock) {
			const blocker = this.pickPlayer(this.d, "blocking", ["C", "W", "D"]);
			this.recordStat(this.d, blocker, "blk", 1);
			this.playByPlay.logEvent({
				type: "block",
				clock: this.clock,
				t: this.d,
				names: [blocker.name],
			});

			if (type === "slapshot" || type === "wristshot") {
				this.injuries({
					type: "block",
					shooter,
					target: blocker,
					t: this.d,
				});
			}

			return "block";
		}

		let deflector;
		if (
			(type === "slapshot" || type === "wristshot") &&
			Math.random() < 0.05 * g.get("deflectionFactor")
		) {
			deflector = this.pickPlayer(this.o, "playmaker", ["C", "W"], 1, [
				shooter,
			]);
			if (deflector) {
				this.playByPlay.logEvent({
					type: "deflection",
					clock: this.clock,
					t: this.o,
					names: [deflector.name],
				});
			}
		}

		// Did the shot miss the net entirely? See the shot-funnel constants above.
		if (
			r <
			SHOT_MISS_BASE -
				SHOT_MISS_SCORING *
					shooter.compositeRating.scoring *
					fatigue(shooter.stat.energy)
		) {
			this.playByPlay.logEvent({
				type: "miss",
				clock: this.clock,
				t: this.o,
				names: [shooter.name],
			});
			return "miss";
		}

		const actualShooter = deflector ?? shooter;

		this.recordStat(this.o, actualShooter, "s");

		let assister1: PlayerGameSim | undefined;
		let assister2: PlayerGameSim | undefined;

		// 25% chance of no assist on shorthanded goal
		if (strengthType !== "sh" || Math.random() > 0.25 || deflector) {
			const r2 = Math.random();
			if (deflector) {
				assister1 = shooter;
			} else if (r2 < 0.97 * g.get("assistFactor")) {
				// 20 power is to ensure top players get a lot
				assister1 = this.pickPlayer(this.o, "playmaker", ["C", "W", "D"], 20, [
					actualShooter,
				]);
			}
			if (r2 < 0.77 * g.get("assistFactor")) {
				// 0.5 power is to ensure that everybody (including defensemen) at least get some
				assister2 = this.pickPlayer(this.o, "playmaker", ["C", "W", "D"], 0.5, [
					actualShooter,
					assister1 as PlayerGameSim,
				]);
			}
		}

		const goalie = this.playersOnIce[this.d].G[0];
		if (goalie) {
			const shotQualityFactors = [
				actualShooter.compositeRating.scoring,
				this.team[this.o].synergy.reb / this.team[this.d].synergy.reb,
			];
			if (assister1) {
				shotQualityFactors.push(assister1.compositeRating.playmaker);
			}
			if (assister2) {
				shotQualityFactors.push(assister2.compositeRating.playmaker);
			}
			let shotQualityFactor = 0;
			for (const factor of shotQualityFactors) {
				shotQualityFactor += factor;
			}
			shotQualityFactor /= shotQualityFactors.length;

			// shotQualityFactor is generally between 0.3 and 0.9, so shotQualityProbComponent is -1 to 1
			const shotQualityProbComponent =
				(helpers.bound(shotQualityFactor, 0.3, 0.9) - 0.3) * (2 / 0.6) - 1;
			const shotQualityProbComponent2 = -0.04 * shotQualityProbComponent; // -0.04 to 0.04

			// Save percentage does not depend on defenders https://www.tsn.ca/defencemen-and-their-impact-on-team-save-percentage-1.567469
			const dShooterSaveBonus =
				actualShooter.pos === "D" ? SHOOTER_D_SAVE_BONUS : 0;

			let savePercentage = helpers.bound(
				Math.min(
					0.99,
					(GOALIE_SAVE_BASE +
						shotQualityProbComponent2 +
						dShooterSaveBonus +
						goalie.compositeRating.goalkeeping * GOALIE_SAVE_GLK) *
						g.get("saveFactor"),
				),
				0,
				1,
			);

			// In All-Star Game, more goals
			if (this.allStarGame) {
				const gap = 1 - savePercentage;
				savePercentage = 1 - 1.9 * gap;
			}

			if (r < savePercentage) {
				const saveType = Math.random() < 0.5 ? "save-freeze" : "save";

				this.recordStat(this.d, goalie, "sv");
				this.playByPlay.logEvent({
					type: saveType,
					clock: this.clock,
					t: this.d,
					names: [goalie.name],
				});

				return saveType;
			}
		} else {
			// Extra 50% chance of miss, for empty net
			if (Math.random() < 0.5) {
				this.playByPlay.logEvent({
					type: "miss",
					clock: this.clock,
					t: this.o,
					names: [shooter.name],
				});
				return "miss";
			}
		}

		let assisterNames: [] | [string] | [string, string];
		let assisterPIDs: [] | [number] | [number, number];
		if (assister1 && assister2) {
			assisterNames = [assister1.name, assister2.name];
			assisterPIDs = [assister1.id, assister2.id];
			this.recordStat(this.o, assister1, `${strengthType}A`);
			this.recordStat(this.o, assister2, `${strengthType}A`);
		} else if (assister1) {
			assisterNames = [assister1.name];
			assisterPIDs = [assister1.id];
			this.recordStat(this.o, assister1, `${strengthType}A`);
		} else {
			assisterNames = [];
			assisterPIDs = [];
		}

		this.recordStat(this.o, actualShooter, `${strengthType}G`);
		if (goalie) {
			this.recordStat(this.d, goalie, "ga");
		}
		this.goaliesAtGoals.push({
			t: this.o,
			goaliePids: [
				this.playersOnIce[0].G[0]?.id,
				this.playersOnIce[1].G[0]?.id,
			],
		});

		const totalG =
			actualShooter.stat["evG"] +
			actualShooter.stat["ppG"] +
			actualShooter.stat["shG"] +
			actualShooter.seasonStats["evG"] +
			actualShooter.seasonStats["ppG"] +
			actualShooter.seasonStats["shG"];
		let totalA: [] | [number] | [number, number];
		if (assister1) {
			const a1 =
				assister1.stat["evA"] +
				assister1.stat["ppA"] +
				assister1.stat["shA"] +
				assister1.seasonStats["evA"] +
				assister1.seasonStats["ppA"] +
				assister1.seasonStats["shA"];
			if (assister2) {
				const a2 =
					assister2.stat["evA"] +
					assister2.stat["ppA"] +
					assister2.stat["shA"] +
					assister2.seasonStats["evA"] +
					assister2.seasonStats["ppA"] +
					assister2.seasonStats["shA"];
				totalA = [a1, a2];
			} else {
				totalA = [a1];
			}
		} else {
			totalA = [];
		}

		this.playByPlay.logEvent({
			type: "goal",
			clock: this.clock,
			t: this.o,
			names: [actualShooter.name, ...assisterNames],
			pids: [actualShooter.id, ...assisterPIDs],
			shotType: deflector ? "deflection" : type,
			goalType: this.pulledGoalie[this.d] ? "en" : strengthType,
			totalGA: this.allStarGame ? undefined : [totalG, ...totalA],
		});

		this.penaltyBox.goal(this.o);

		if (this.overtime) {
			// Sudden death, so this goal wins the game
			const overtimePart =
				this.overtimes > 1
					? `the ${helpers.ordinal(this.overtimes)} overtime`
					: `${this.threeOnThree ? "3-on-3 " : ""}overtime`;
			this.clutchPlays.push({
				text: `<a href="${helpers.leagueUrl(["player", actualShooter.id])}">${
					actualShooter.name
				}</a> scored the game-winning goal in ${overtimePart}`,
				showNotification: this.team[this.o].id === g.get("userTid"),
				pids: [actualShooter.id],
				tids: [this.team[this.o].id],
			});
		}

		return "goal";
	}

	faceoff() {
		this.updatePlayersOnIce({ type: "normal" });

		const p0 = this.getTopPlayerOnIce(0, "faceoffs", ["C", "W", "D"]);
		const p1 = this.getTopPlayerOnIce(1, "faceoffs", ["C", "W", "D"]);

		const winner = choice([p0, p1], (p) => p.compositeRating.faceoffs ** 0.5);

		let names: [string, string];
		if (winner === p0) {
			this.o = 0;
			this.d = 1;
			this.recordStat(0, p0, "fow");
			this.recordStat(1, p1, "fol");
			names = [p0.name, p1.name];
		} else {
			this.o = 1;
			this.d = 0;
			this.recordStat(1, p1, "fow");
			this.recordStat(0, p0, "fol");
			names = [p1.name, p0.name];
		}

		this.playByPlay.logEvent({
			type: "faceoff",
			clock: this.clock,
			t: this.o,
			names,
		});

		this.advanceClock();
	}

	checkPenalty() {
		if (this.allStarGame && Math.random() < 0.9) {
			return false;
		}

		const r = Math.random();

		// checkPenalty is rolled once per possession, and hockey's pace override makes a
		// possession much shorter than a minute, so this fires ~140x/game - not the ~60 a
		// "60 seconds per possession" reading of the penalties table would imply. 0.041 is
		// calibrated empirically against that real call frequency to land ~3.1 power-play
		// opportunities and ~8.4 PIM per team per game, matching the NHL (~3.0-3.4 PPO,
		// ~8-9 PIM). The original 0.06 produced ~4.4 PPO / ~11 PIM, well above the NHL.
		const probPenaltyPerPossession = 0.041 * g.get("foulRateFactor");

		if (r > probPenaltyPerPossession) {
			return;
		}

		const penalty = choice(penalties, (penalty) => penalty.numPerSeason);

		if (!penalty) {
			return false;
		}

		const t = choice(teamNums, (t) => this.team[t].compositeRating.penalties);

		// Hack - don't want to deal with >2 penalties at the same time
		if (this.penaltyBox.count(t) >= 2) {
			return false;
		}

		// Power 2 amplifies the penalties-composite gap so a high-checking enforcer absorbs
		// most of his team's penalties and disciplined stars take few, overcoming the fact
		// that stars are on the ice (and thus exposed to penalty rolls) far more
		const p = this.pickPlayer(t, "penalties", ["C", "W", "D"], 2);

		const penaltyType = penaltyTypes[penalty.type];

		this.penaltyBox.add(t, p, penalty);

		if (penalty.type === "major") {
			this.majorPenalties.push({
				pid: p.id,
				name: penalty.name,
			});
		}

		this.recordStat(t, p, "pim", penaltyType.minutes);
		this.playByPlay.logEvent({
			type: "penalty",
			clock: this.clock,
			t,
			names: [p.name],
			penaltyType: penalty.type,
			penaltyName: penalty.name,
			penaltyPID: p.id,
		});

		// Actually remove player from ice
		this.updatePlayersOnIce({ type: "penalty" });

		return true;
	}

	checkPullGoalie(t0: TeamNum) {
		const t1 = t0 === 0 ? 1 : 0;

		const shouldPullGoalie = () => {
			const period = this.team[0].stat.ptsQtrs.length;

			if (period !== this.numPeriods) {
				return false;
			}

			const scoreDifferential = this.team[t0].stat.pts - this.team[t1].stat.pts;

			if (scoreDifferential >= 0) {
				return false;
			}

			if (scoreDifferential === -1 && this.clock <= 2) {
				return true;
			}

			if (
				(scoreDifferential === -2 || scoreDifferential === -3) &&
				this.clock <= 3
			) {
				return true;
			}

			return false;
		};

		const shouldPull = shouldPullGoalie();

		if (!this.pulledGoalie[t0] && shouldPull) {
			this.updatePlayersOnIce({
				type: "pullGoalie",
				t: t0,
			});
		} else if (this.pulledGoalie[t0] && !shouldPull) {
			this.updatePlayersOnIce({
				type: "noPullGoalie",
				t: t0,
			});
		}
	}

	checkGoalieHook(t: TeamNum) {
		// At most one hook per game per team, and never while the net is empty for an extra attacker
		if (this.hookedGoalie[t] || this.pulledGoalie[t]) {
			return;
		}

		const goalie = this.playersOnIce[t].G[0];
		if (!goalie) {
			return;
		}

		const backup = this.backupGoalies[t];
		if (
			!backup ||
			backup === goalie ||
			backup.injured ||
			this.penaltyBox.has(t, backup) ||
			// A "backup" who is dressed as a skater (pathological roster with too few goalies) cannot take the net
			this.lines[t].F.flat().includes(backup) ||
			this.lines[t].D.flat().includes(backup) ||
			Object.values(this.playersOnIce[t]).flat().includes(backup)
		) {
			return;
		}

		const ga = goalie.stat.ga;
		const shots = ga + goalie.stat.sv;
		const saveFraction = shots > 0 ? goalie.stat.sv / shots : 1;
		const period = this.team[0].stat.ptsQtrs.length;

		const shouldHook =
			ga >= GOALIE_HOOK.gaAnytime ||
			(ga >= GOALIE_HOOK.gaPoorSv &&
				saveFraction < GOALIE_HOOK.poorSvFraction) ||
			(period === 1 &&
				ga >= GOALIE_HOOK.gaFirstPeriod &&
				saveFraction < GOALIE_HOOK.firstPeriodSvFraction);

		if (shouldHook) {
			this.updatePlayersOnIce({
				type: "goalieHook",
				t,
			});
		}
	}

	simPossession(special?: "rebound") {
		if (!special) {
			if (this.isHit()) {
				const fight = this.doHit();

				if (fight) {
					// Like a penalty, a fight stops play and leads to a faceoff
					this.faceoff();
					return;
				}

				if (this.advanceClock()) {
					return;
				}
			}

			if (this.checkPenalty()) {
				this.faceoff();
				return;
			}

			if (this.advanceClock()) {
				return;
			}

			if (this.isGiveaway()) {
				this.doGiveaway();
				return;
			}

			if (this.isTakeaway()) {
				this.doTakeaway();
				return;
			}

			if (this.isNothing()) {
				return;
			}
		}

		if (this.advanceClock(special)) {
			return;
		}

		const outcome = this.doShot(special);

		if (outcome === "block" || outcome === "miss") {
			const r = Math.random();
			if (r < 0.5) {
				this.possessionChange();
			} else if (r < 0.6 && !this.pulledGoalie[this.d]) {
				this.simPossession("rebound");
			}

			return;
		}

		if (outcome === "save") {
			const r = Math.random();
			if (r < 0.5) {
				this.possessionChange();
			} else if (r < 0.7 && !this.pulledGoalie[this.d]) {
				this.simPossession("rebound");
			}

			return;
		}

		if (outcome === "save-freeze") {
			this.faceoff();
			return;
		}

		if (outcome === "goal") {
			if (this.overtime) {
				// Sudden death overtime
				return;
			}

			this.checkPullGoalie(this.o);
			this.checkPullGoalie(this.d);

			this.faceoff();
			return;
		}
	}

	// A unit whose best creator and best finisher are on par plays above the sum of its parts; a line of three snipers (or a pair of two offensive defensemen) plays below it. Centered so a typical mixed unit is near 0.
	getLineComplementarity(t: TeamNum) {
		const forwards = [...this.playersOnIce[t].C, ...this.playersOnIce[t].W];
		const defensemen = this.playersOnIce[t].D;

		let complementarity = 0;

		if (forwards.length >= 2) {
			let bestPlaymaker = 0;
			let bestSniper = 0;
			for (const p of forwards) {
				bestPlaymaker = Math.max(bestPlaymaker, p.compositeRating.playmaker);
				bestSniper = Math.max(bestSniper, p.compositeRating.sniper);
			}

			complementarity += 0.1 * (0.15 - Math.abs(bestPlaymaker - bestSniper));
		}

		if (defensemen.length >= 2) {
			let bestOffensive = 0;
			let bestDefensive = 0;
			for (const p of defensemen) {
				bestOffensive = Math.max(bestOffensive, p.compositeRating.playmaker);
				bestDefensive = Math.max(bestDefensive, p.compositeRating.blocking);
			}

			complementarity += 0.1 * (0.15 - Math.abs(bestOffensive - bestDefensive));
		}

		// Each term caps at +0.015, so the positive side tops out at +0.03; only the negative side can hit its clamp
		return helpers.bound(complementarity, -0.05, 0.03);
	}

	updateTeamCompositeRatings() {
		for (const t of teamNums) {
			let synergy = 0;
			for (const pos of ["C", "W", "D"] as const) {
				for (const p of this.playersOnIce[t][pos]) {
					synergy += p.ovrs[pos];
				}
			}
			synergy /= 500; // 0 to 1 scale

			// Linemate complementarity moves the whole unit's effective strength, which flows into the composite ratings below, the shot quality factor in doShot, and (squared, since both teams' composites carry reciprocal ratios) the giveaway/takeaway probabilities
			synergy *= 1 + this.getLineComplementarity(t);

			this.team[t].synergy.reb = synergy;
		}

		for (const t of teamNums) {
			const t2 = t === 0 ? 1 : 0;
			const synergyRatio = this.team[t].synergy.reb / this.team[t2].synergy.reb;

			this.team[t].compositeRating.hitting = getCompositeFactor({
				playersOnIce: this.playersOnIce[t],
				positions: {
					D: 1,
					W: 0.5,
					C: 0.25,
				},
				synergyFactor: this.synergyFactor,
				synergyRatio,
				valFunc: (p) => (p.ovrs.D / 100 + p.compositeRating.enforcer) / 2,
			});

			this.team[t].compositeRating.penalties = getCompositeFactor({
				playersOnIce: this.playersOnIce[t],
				positions: {
					D: 1,
					W: 0.5,
					C: 0.25,
				},
				// This composite only decides which team TAKES the penalty (higher = worse), so scaling it by on-ice strength would perversely punish the better unit
				synergyFactor: 0,
				synergyRatio,
				valFunc: (p) => p.compositeRating.penalties / 2,
			});

			this.team[t].compositeRating.puckControl = getCompositeFactor({
				playersOnIce: this.playersOnIce[t],
				positions: {
					C: 1,
					W: 0.5,
					D: 0.25,
				},
				synergyFactor: this.synergyFactor,
				synergyRatio,
				valFunc: (p) => p.compositeRating.playmaker,
			});

			this.team[t].compositeRating.takeaway = getCompositeFactor({
				playersOnIce: this.playersOnIce[t],
				positions: {
					D: 1,
					W: 0.5,
					C: 0.25,
				},
				synergyFactor: this.synergyFactor,
				synergyRatio,
				valFunc: (p) => (p.ovrs.D / 100 + p.compositeRating.grinder) / 2,
			});

			this.team[t].compositeRating.blocking = getCompositeFactor({
				playersOnIce: this.playersOnIce[t],
				positions: {
					D: 1,
					W: 0.5,
					C: 0.25,
				},
				synergyFactor: this.synergyFactor,
				synergyRatio,
				valFunc: (p) => (p.ovrs.D / 100 + p.compositeRating.blocking) / 2,
			});

			this.team[t].compositeRating.scoring = getCompositeFactor({
				playersOnIce: this.playersOnIce[t],
				positions: {
					C: 1,
					W: 0.5,
					D: 0.25,
				},
				synergyFactor: this.synergyFactor,
				synergyRatio,
				valFunc: (p) => p.compositeRating.scoring,
			});
		}
	}

	getPlayerFromNextLine(
		t: TeamNum,
		pos: "F" | "D",
		playersRemainingOn: PlayerGameSim[],
	) {
		// Never pick a player who is in the penalty box or already on the ice
		const isAvailable = (p: PlayerGameSim) =>
			!this.penaltyBox.has(t, p) && !playersRemainingOn.includes(p);

		const nextLine =
			this.lines[t][pos][(this.currentLine[t][pos] + 1) % NUM_LINES[pos]]!;
		let candidates = nextLine.filter(isAvailable);
		if (candidates.length === 0 && this.currentLine[t][pos] !== 0) {
			// This could happen if a line is empty due to a ton of injuries, or entirely in the penalty box
			candidates = this.lines[t][pos][0]!.filter(isAvailable);
		}

		if (candidates.length === 0) {
			// This could happen if a player gets a penalty while being on the only healthy line remaining due to many injuries
			let emergencyPlayers = [];
			for (const existingLines of Object.values(this.lines[t])) {
				for (const existingLine of existingLines) {
					emergencyPlayers.push(...existingLine);
				}
			}
			emergencyPlayers = emergencyPlayers.filter(isAvailable);
			if (emergencyPlayers.length === 0) {
				// This could happen if everyone is injured resulting in lines not having players
				emergencyPlayers = this.team[t].depth[pos].filter(isAvailable);
			}
			if (emergencyPlayers.length === 0) {
				// Last resort, should not happen: accept a boxed player rather than nobody
				emergencyPlayers = this.team[t].depth[pos].filter(
					(p) => !playersRemainingOn.includes(p),
				);
			}
			return choice(emergencyPlayers);
		}

		return choice(candidates);
	}

	// In 3-on-3 overtime, a penalty gives the power play team an EXTRA skater rather than costing the penalized team one - each side ices 3 plus the opponent's box count, capped at 5 (NHL rule 84.3). So one penalty is 4-on-3, offsetting penalties are 4-on-4, 2-1 is 5-on-4 - no team ever ices fewer than 3 skaters
	getThreeOnThreeComposition(t: TeamNum) {
		const t2 = t === 0 ? 1 : 0;
		const numSkaters = Math.min(5, 3 + this.penaltyBox.count(t2));
		const numD = numSkaters === 5 ? 2 : 1;

		return {
			F: numSkaters - numD,
			D: numD,
		};
	}

	// NHL coaches send their best offensive skaters in 3-on-3 overtime rather than rolling regular lines. Weighted random picks from the top of the pool (with fatigue) rotate the overtime units.
	pickThreeOnThreeSkaters(
		t: TeamNum,
		pos: "F" | "D",
		numNeeded: number,
		playersRemainingOn: PlayerGameSim[],
	) {
		const otRating = (p: PlayerGameSim) =>
			((p.compositeRating.scoring + p.compositeRating.playmaker) / 2) *
			fatigue(p.stat.energy);

		const candidates = this.lines[t][pos]
			.flat()
			.filter(
				(p) => !this.penaltyBox.has(t, p) && !playersRemainingOn.includes(p),
			);

		const pool = orderBy(candidates, otRating, "desc").slice(
			0,
			THREE_ON_THREE_POOL_SIZE[pos],
		);

		const skaters: PlayerGameSim[] = [];
		while (skaters.length < numNeeded && pool.length > 0) {
			const p = choice(pool, (p2) => otRating(p2) ** 2);
			skaters.push(p);
			pool.splice(pool.indexOf(p), 1);
		}

		// Emergency fallback, like if too many players are injured or in the penalty box
		while (skaters.length < numNeeded) {
			const p = this.getPlayerFromNextLine(t, pos, [
				...skaters,
				...playersRemainingOn,
			]);
			if (!p || skaters.includes(p)) {
				break;
			}
			skaters.push(p);
		}

		return skaters;
	}

	doLineChange(
		t: TeamNum,
		pos: "F" | "D",
		playersRemainingOn: PlayerGameSim[],
	) {
		this.minutesSinceLineChange[t][pos] = 0;
		this.currentLine[t][pos] += 1;

		if (!this.allStarGame) {
			const { powerPlayTeam } = this.penaltyBox.getPowerPlayTeam();
			if (powerPlayTeam === t) {
				// On the power play, send out a top unit (like PP1/PP2 in real life) rather than continuing the normal rotation
				this.currentLine[t][pos] = Math.random() < 0.75 ? 0 : 1;
			} else if (pos === "F") {
				// Sometimes skip the 3rd line of forwards, giving the shift back to the
				// top line (kept light so the 3rd line still gets real minutes)
				if (this.currentLine[t][pos] === 2 && Math.random() < 0.15) {
					this.currentLine[t][pos] = 0;
				}

				// Sometimes skip the 4th line of forwards. Less aggressive than before so
				// the 4th line plays an NHL-like ~9-11 min instead of being scratched
				if (this.currentLine[t][pos] >= 3 && Math.random() < 0.35) {
					this.currentLine[t][pos] = 0;
				}
			}
		}

		let newLine = this.lines[t][pos][this.currentLine[t][pos]];
		if (!newLine || newLine.length < NUM_PLAYERS_PER_LINE[pos]) {
			this.currentLine[t][pos] = 0;
			newLine = this.lines[t][pos][this.currentLine[t][pos]]!;
		}

		newLine = [...newLine];
		for (const [i, p] of newLine.entries()) {
			if (this.penaltyBox.has(t, p) || playersRemainingOn.includes(p)) {
				// Also exclude the rest of newLine, so a replacement can't duplicate a player already slated to be on the ice
				newLine[i] = this.getPlayerFromNextLine(t, pos, [
					...playersRemainingOn,
					...newLine,
				]);
			}
		}

		if (pos === "F") {
			const penaltyBoxCount = this.penaltyBox.count(t);
			if (this.threeOnThree && !this.pulledGoalie[t]) {
				// 2 forwards at 3-on-3, 3 on a 4-on-3 or 5-on-3 power play. Handles any penalty box count, so the "Not implemented" throw below is unreachable in overtime.
				const otForwards = this.pickThreeOnThreeSkaters(
					t,
					pos,
					this.getThreeOnThreeComposition(t).F,
					playersRemainingOn,
				);
				this.playersOnIce[t].C = otForwards.slice(0, 1);
				this.playersOnIce[t].W = otForwards.slice(1);
			} else if (
				penaltyBoxCount === 0 ||
				(this.pulledGoalie[t] && penaltyBoxCount === 1)
			) {
				// Normal
				this.playersOnIce[t].C = newLine.slice(0, 1);
				this.playersOnIce[t].W = newLine.slice(1, 3);
			} else if (
				penaltyBoxCount === 1 ||
				(this.pulledGoalie[t] && penaltyBoxCount === 2)
			) {
				// Leave out a forward
				const r = Math.random();
				if (r < 0.33) {
					this.playersOnIce[t].C = newLine.slice(0, 1);
					this.playersOnIce[t].W = newLine.slice(1, 2);
				} else if (r < 0.67) {
					this.playersOnIce[t].C = newLine.slice(0, 1);
					this.playersOnIce[t].W = newLine.slice(2, 3);
				} else {
					this.playersOnIce[t].C = [];
					this.playersOnIce[t].W = newLine.slice(1, 3);
				}
			} else if (penaltyBoxCount === 2) {
				// Leave out two forwards
				const r = Math.random();
				if (r < 0.33) {
					this.playersOnIce[t].C = newLine.slice(0, 1);
					this.playersOnIce[t].W = [];
				} else if (r < 0.67) {
					this.playersOnIce[t].C = [];
					this.playersOnIce[t].W = newLine.slice(1, 2);
				} else {
					this.playersOnIce[t].C = [];
					this.playersOnIce[t].W = newLine.slice(2, 3);
				}
			} else {
				throw new Error("Not implemented");
			}

			if (penaltyBoxCount === 0 && this.pulledGoalie[t]) {
				// Add extra skater
				this.playersOnIce[t].C.push(
					this.getPlayerFromNextLine(t, pos, [
						...this.playersOnIce[t].C,
						...this.playersOnIce[t].W,
						...playersRemainingOn,
					]),
				);
			}
		} else {
			if (this.threeOnThree && !this.pulledGoalie[t]) {
				// 1 defenseman at 3-on-3 and 4-on-3, 2 on a 5-on-3 power play
				this.playersOnIce[t].D = this.pickThreeOnThreeSkaters(
					t,
					pos,
					this.getThreeOnThreeComposition(t).D,
					playersRemainingOn,
				);
			} else {
				this.playersOnIce[t].D = newLine;
			}
		}

		let actualNewLine;
		if (pos === "F") {
			actualNewLine = [...this.playersOnIce[t].C, ...this.playersOnIce[t].W];
		} else {
			actualNewLine = this.playersOnIce[t].D;
		}
		for (const p of actualNewLine) {
			this.recordStat(t, p, "shft");
		}
	}

	updatePlayersOnIce(
		options:
			| {
					type: "starters" | "newPeriod" | "normal" | "penalty";
					p?: undefined;
			  }
			| {
					type: "penaltyOver";
					p: PlayerGameSim;
					t: TeamNum;
			  }
			| {
					type: "pullGoalie" | "noPullGoalie" | "goalieHook";
					t: TeamNum;
			  },
	) {
		let substitutions = false;

		for (const t of teamNums) {
			if (options.type === "starters") {
				this.playersOnIce[t].C = this.lines[t].F[0]!.slice(0, 1);
				this.playersOnIce[t].W = this.lines[t].F[0]!.slice(1, 3);
				this.playersOnIce[t].D = [...this.lines[t].D[0]!];
				this.playersOnIce[t].G = [...this.lines[t].G[0]!];

				// No need to track shft here because updatePlayersOnIce will be called with newPeriod anyway. So actually, this "starters" mode of updatePlayersOnIce could be eliminated as long as gs was tracked properly in the first newPeriod call.
			} else if (options.type === "penaltyOver") {
				if (options.t !== t) {
					continue;
				}

				// At 3-on-3 with stacked penalties the team can already be at the full 5 skaters (impossible in regulation, where a penalized team ices at most 4) - then the released player waits for the next line change instead of becoming a 6th skater
				const numSkaters =
					this.playersOnIce[t].C.length +
					this.playersOnIce[t].W.length +
					this.playersOnIce[t].D.length;
				if (!this.pulledGoalie[t] && numSkaters >= 5) {
					continue;
				}

				if (
					this.playersOnIce[t].C.length < 1 ||
					(this.pulledGoalie[t] && this.playersOnIce[t].C.length < 2)
				) {
					this.playersOnIce[t].C.push(options.p);
				} else if (this.playersOnIce[t].W.length < 2) {
					this.playersOnIce[t].W.push(options.p);
				} else {
					this.playersOnIce[t].D.push(options.p);
				}
				substitutions = true;
			} else if (options.type === "pullGoalie") {
				if (options.t !== t) {
					continue;
				}

				const currentlyOnIce = Object.values(this.playersOnIce[t]).flat();
				const sub = this.getPlayerFromNextLine(t, "F", currentlyOnIce);

				this.playersOnIce[t].G = [];
				this.playersOnIce[t].C.push(sub);
				this.recordStat(t, sub, "shft");

				this.playByPlay.logEvent({
					type: "pullGoalie",
					clock: this.clock,
					t,
					name: sub.name,
				});

				this.pulledGoalie[t] = true;
				substitutions = true;
			} else if (options.type === "goalieHook") {
				if (options.t !== t) {
					continue;
				}

				const backup = this.backupGoalies[t];
				if (!backup) {
					throw new Error("goalieHook failed - no backup goalie");
				}

				// Mutating lines.G too keeps the shootout and noPullGoalie paths pointing at the relief goalie
				this.lines[t].G[0] = [backup];
				this.playersOnIce[t].G = [backup];

				this.playByPlay.logEvent({
					type: "goalieHook",
					clock: this.clock,
					t,
					name: backup.name,
				});

				this.hookedGoalie[t] = true;
				substitutions = true;
			} else if (options.type === "noPullGoalie") {
				if (options.t !== t) {
					continue;
				}

				const currentlyOnIce = Object.values(this.playersOnIce[t]).flat();
				const goalie = this.lines[t].G.flat().find(
					(p) => !currentlyOnIce.includes(p),
				);
				if (!goalie) {
					throw new Error("noPullGoalie failed - goalie not found");
				}

				// Ideally sub out the 2nd center, since that is normally the extra skater. But in penalty situations, there may not be a 2nd center. Then look for the last winger, or the 1st center, or the last defenseman.
				const sub =
					this.playersOnIce[t].C[1] ??
					this.playersOnIce[t].W.at(-1) ??
					this.playersOnIce[t].C.at(-1) ??
					this.playersOnIce[t].D.at(-1);
				if (!sub) {
					throw new Error("noPullGoalie failed - skater not found");
				}

				this.playersOnIce[t].G = [goalie];
				this.playersOnIce[t].C = this.playersOnIce[t].C.slice(0, 1);

				this.playByPlay.logEvent({
					type: "noPullGoalie",
					clock: this.clock,
					t,
					name: goalie.name,
				});

				this.pulledGoalie[t] = false;
				substitutions = true;
			} else {
				// Line change based on playing time
				let lineChangeEvent:
					| "offensiveLineChange"
					| "fullLineChange"
					| "defensiveLineChange"
					| undefined;

				if (options.type === "newPeriod") {
					// Like starters, except someone might be in the penalty box

					// Put in the top line by pretending the last line is in
					this.currentLine[t].F = NUM_LINES.F - 1;
					this.currentLine[t].D = NUM_LINES.D - 1;
					lineChangeEvent = "fullLineChange";
				} else if (this.clock >= 1 || options.type === "penalty") {
					if (
						(this.minutesSinceLineChange[t].F >= 0.7 && Math.random() < 0.75) ||
						options.type === "penalty"
					) {
						lineChangeEvent = "offensiveLineChange";
					}
					if (
						(this.minutesSinceLineChange[t].D >= 0.9 && Math.random() < 0.75) ||
						options.type === "penalty"
					) {
						if (lineChangeEvent) {
							lineChangeEvent = "fullLineChange";
						} else {
							lineChangeEvent = "defensiveLineChange";
						}
					}
				}

				if (lineChangeEvent) {
					if (lineChangeEvent === "offensiveLineChange") {
						this.doLineChange(t, "F", [
							...this.playersOnIce[t].D,
							...this.playersOnIce[t].G,
						]);
					} else if (lineChangeEvent === "defensiveLineChange") {
						this.doLineChange(t, "D", [
							...this.playersOnIce[t].C,
							...this.playersOnIce[t].W,
							...this.playersOnIce[t].G,
						]);
					} else {
						this.doLineChange(t, "F", [...this.playersOnIce[t].G]);
						this.doLineChange(t, "D", [
							...this.playersOnIce[t].C,
							...this.playersOnIce[t].W,
							...this.playersOnIce[t].G,
						]);
					}
					substitutions = true;

					if (options.type !== "newPeriod") {
						this.playByPlay.logEvent({
							type: lineChangeEvent,
							clock: this.clock,
							t,
						});
					}
				}
			}

			const currentlyOnIce = Object.values(this.playersOnIce[t]).flat();
			for (const p of currentlyOnIce) {
				if (options.type === "starters") {
					this.recordStat(t, p, "gs");
				}
				this.recordStat(t, p, "gp");
			}

			if (substitutions || options.type === "starters") {
				for (const pos of helpers.keys(this.playersOnIce[t])) {
					for (const p of this.playersOnIce[t][pos]) {
						const stat = pos === "G" ? "gpGoalie" : "gpSkater";
						if (p.stat[stat] === 0) {
							this.recordStat(t, p, stat);
						}
					}
				}

				this.playByPlay.logEvent({
					type: "playersOnIce",
					t,
					pids: Object.values(this.playersOnIce[t])
						.flat()
						.map((p) => p.id),
				});
			}
		}

		if (substitutions || options.type === "starters") {
			this.updateTeamCompositeRatings();
		}
	}

	updatePlayingTime(possessionTime: number) {
		const onField = new Set();

		for (const t of teamNums) {
			const t2 = t === 0 ? 1 : 0;
			const penaltyBoxDiff =
				this.penaltyBox.count(t) - this.penaltyBox.count(t2);
			let strengthType: "ev" | "sh" | "pp" = "ev";
			if (penaltyBoxDiff > 0) {
				strengthType = "sh";
			} else if (penaltyBoxDiff < 0) {
				strengthType = "pp";
			}

			for (const pos of helpers.keys(this.playersOnIce[t])) {
				for (const p of this.playersOnIce[t][pos]) {
					onField.add(p.id);
					this.recordStat(t, p, "min", possessionTime);
					if (strengthType === "pp") {
						this.recordStat(t, p, "ppMin", possessionTime);
					} else if (strengthType === "sh") {
						this.recordStat(t, p, "shMin", possessionTime);
					}
					this.recordStat(t, p, "courtTime", possessionTime);

					if (pos === "G") {
						this.recordStat(t, p, "gMin", possessionTime);
					}

					// This used to be 0.04. Increase more to lower PT
					this.recordStat(t, p, "energy", -0.25 * possessionTime);

					if (p.stat.energy < 0) {
						p.stat.energy = 0;
					}
				}
			}

			for (const p of this.team[t].player) {
				if (!onField.has(p.id)) {
					this.recordStat(t, p, "benchTime", possessionTime);

					// Any player on the bench is full strength the next time he comes on
					p.stat.energy = 1;
				}
			}
		}
	}

	injuries(
		info?:
			| {
					type: "hit";
					hitter: PlayerGameSim;
					target: PlayerGameSim;
					t: TeamNum;
			  }
			| {
					type: "block";
					shooter: PlayerGameSim;
					target: PlayerGameSim;
					t: TeamNum;
			  },
	) {
		if (this.baseInjuryRate === 0) {
			return;
		}

		let injuryOccurred = false;

		if (info) {
			// Some chance of a hit/block resulting in injury
			if (info.type === "hit") {
				if (
					Math.random() <
					250 * info.hitter.compositeRating.enforcer * this.baseInjuryRate
				) {
					info.target.injured = true;
					info.target.newInjury = true;
					this.playByPlay.logEvent({
						type: "injury",
						clock: this.clock,
						t: info.t,
						names: [info.target.name],
						injuredPID: info.target.id,
					});
					injuryOccurred = true;
				}
			} else {
				if (
					Math.random() <
					250 * info.shooter.compositeRating.sniper * this.baseInjuryRate
				) {
					info.target.injured = true;
					info.target.newInjury = true;
					this.playByPlay.logEvent({
						type: "injury",
						clock: this.clock,
						t: info.t,
						names: [info.target.name],
						injuredPID: info.target.id,
					});
					injuryOccurred = true;
				}
			}
		} else {
			for (const t of teamNums) {
				for (const pos of helpers.keys(this.playersOnIce[t])) {
					for (const p of this.playersOnIce[t][pos]) {
						let injuryRate = getInjuryRate(
							this.baseInjuryRate,
							p.age,
							p.injury.gamesRemaining > 0,
						);

						// Fewer injuries for G
						if (pos === "G") {
							injuryRate *= 0.25;
						}

						if (Math.random() < injuryRate) {
							p.injured = true;
							p.newInjury = true;
							this.playByPlay.logEvent({
								type: "injury",
								clock: this.clock,
								t,
								names: [p.name],
								injuredPID: p.id,
							});
							injuryOccurred = true;
						}
					}
				}
			}
		}

		if (injuryOccurred) {
			this.setLines();
		}
	}

	pickPlayer(
		t: TeamNum,
		rating?: CompositeRating,
		positions: Position[] = POSITIONS,
		power: number = 1,
		ignorePlayers?: PlayerGameSim[],
	) {
		let players = getPlayers(this.playersOnIce[t], positions);
		if (ignorePlayers) {
			players = players.filter((p) => !ignorePlayers.includes(p));
		}

		const weightFunc =
			rating !== undefined
				? (p: PlayerGameSim) => {
						// Less likely, but not impossible, for injured players to do stuff
						const injuryFactor = p.injured ? 0.5 : 1;

						return (
							(p.compositeRating[rating] *
								fatigue(p.stat.energy) *
								injuryFactor) **
							power
						);
					}
				: undefined;
		return choice(players, weightFunc);
	}

	getTopPlayerOnIce(
		t: TeamNum,
		rating: CompositeRating,
		positions: Position[] = POSITIONS,
	) {
		const players = orderBy(
			getPlayers(this.playersOnIce[t], positions),
			(p) => p.compositeRating[rating] * fatigue(p.stat.energy),
			"desc",
		);

		return players[0]!;
	}

	// Pass undefined as p for some team-only stats
	recordStat(
		t: TeamNum,
		p: PlayerGameSim | undefined,
		s: string,
		amt: number = 1,
	) {
		const qtr = this.team[t].stat.ptsQtrs.length - 1;

		if (p !== undefined) {
			if (s === "gp") {
				p.stat[s] = 1;
			} else {
				p.stat[s] += amt;
			}
		}

		// Filter out stats that don't get saved to box score
		if (
			s !== "gs" &&
			s !== "gp" &&
			s !== "courtTime" &&
			s !== "benchTime" &&
			s !== "energy"
		) {
			// Filter out stats that are only for player, not team
			if (
				s !== "ppMin" &&
				s !== "shMin" &&
				s !== "gpSkater" &&
				s !== "gpGoalie" &&
				s !== "ga" &&
				s !== "gMin"
			) {
				this.team[t].stat[s] += amt;

				let pts;

				if (GOALS.has(s)) {
					pts = 1;
				}

				if (pts !== undefined) {
					this.team[t].stat.pts += pts;
					this.team[t].stat.ptsQtrs[qtr] += pts;
					this.playByPlay.logStat(t, undefined, "pts", pts);

					// Power play goals don't count for +/-
					if (s !== "ppG") {
						for (const t2 of teamNums) {
							const currentlyOnIce = Object.values(
								this.playersOnIce[t2],
							).flat();
							for (const p2 of currentlyOnIce) {
								const pm = t2 === t ? 1 : -1;
								p2.stat.pm += pm;
								this.playByPlay.logStat(t2, p2.id, "pm", pm);
							}
						}
					}
				}
			}

			if (p !== undefined) {
				this.playByPlay.logStat(t, p.id, s, amt);
			}

			if (s === "ppo" || s === "sAtt" || s === "sPts") {
				this.playByPlay.logStat(t, undefined, s, amt);
			}
		}
	}
}

export default GameSim;
