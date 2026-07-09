import clsx from "clsx";
import { useState } from "react";
import { NUM_LINES } from "../../common/constants.hockey.ts";
import { range } from "../../common/utils.ts";
import { helpers } from "../util/helpers.ts";
import { PlayerNameLabels } from "./PlayerNameLabels.tsx";
import { PlayerPicture } from "./PlayerPicture.tsx";

const getSlots = (pos: string) => {
	if (pos === "F") {
		return {
			numLines: NUM_LINES.F,
			ratingPositions: ["C", "W", "W"],
			slotLabels: ["C", "W", "W"],
			validPositions: ["C", "W"],
			showLineNumbers: true,

			// Depth order is C/W/W, but display the center between his wingers
			displayOrder: [1, 0, 2],
		};
	}

	if (pos === "D") {
		return {
			numLines: NUM_LINES.D,
			ratingPositions: ["D", "D"],
			slotLabels: ["D", "D"],
			validPositions: ["D"],
			showLineNumbers: true,
			displayOrder: [0, 1],
		};
	}

	return {
		numLines: 1,
		ratingPositions: ["G", "G"],
		slotLabels: ["Starter", "Backup"],
		validPositions: ["G"],
		showLineNumbers: false,
		displayOrder: [0, 1],
	};
};

const CARD_WIDTH = 230;

export const HockeyLineCards = ({
	challengeNoRatings,
	editable,
	onSwap,
	players,
	pos,
	teamColors,
	teamJersey,
}: {
	challengeNoRatings: boolean;
	editable: boolean;
	onSwap: (index1: number, index2: number) => Promise<void>;
	players: any[];
	pos: string;
	teamColors?: [string, string, string];
	teamJersey?: string;
}) => {
	const [selectedIndex, setSelectedIndex] = useState<number | undefined>();

	const {
		displayOrder,
		numLines,
		ratingPositions,
		slotLabels,
		validPositions,
		showLineNumbers,
	} = getSlots(pos);

	const numStarters = numLines * ratingPositions.length;

	const handleClick = (index: number) => {
		if (!editable) {
			return;
		}

		if (selectedIndex === undefined) {
			setSelectedIndex(index);
		} else if (selectedIndex === index) {
			setSelectedIndex(undefined);
		} else {
			setSelectedIndex(undefined);
			void onSwap(selectedIndex, index);
		}
	};

	const renderCard = (
		index: number,
		slotLabel?: string,
		ratingPos?: string,
	) => {
		const p = players[index];

		if (!p) {
			return (
				<div
					className="card justify-content-center text-center text-body-secondary"
					key={`empty-${index}`}
					style={{ width: CARD_WIDTH }}
				>
					Empty
				</div>
			);
		}

		const naturalPos = p.ratings.pos;
		const ratingPos2 = ratingPos ?? naturalPos;
		const slotLabel2 = slotLabel ?? naturalPos;
		const ovr = challengeNoRatings ? undefined : p.ratings.ovrs[ratingPos2];

		const statsLine =
			pos === "G"
				? `${p.stats.gp} GP, ${helpers.roundStat(p.stats.gaa, "gaa")} GAA, ${helpers.roundStat(p.stats.svPct, "svPct")} SV%`
				: `${p.stats.gp} GP, ${p.stats.g}-${p.stats.a}-${p.stats.pts}`;

		const selected = selectedIndex === index;

		return (
			<div
				className={clsx("card", selected && "border-primary shadow")}
				key={p.pid}
				onClick={() => {
					handleClick(index);
				}}
				role={editable ? "button" : undefined}
				style={{ width: CARD_WIDTH }}
			>
				<div className="card-body p-2 d-flex align-items-center gap-2">
					<div
						className="flex-shrink-0 overflow-hidden"
						style={{ width: 48, height: 48 }}
					>
						<PlayerPicture
							colors={teamColors}
							face={p.face}
							imgURL={p.imgURL}
							jersey={teamJersey}
							lazy
						/>
					</div>
					<div className="overflow-hidden">
						<div className="text-nowrap">
							<PlayerNameLabels
								pid={p.pid}
								injury={p.injury}
								skills={p.ratings.skills}
								defaultWatch={p.watch}
								firstName={p.firstName}
								firstNameShort={p.firstNameShort}
								lastName={p.lastName}
							/>
						</div>
						<div className="text-nowrap small">
							{slotLabel !== undefined ? (
								<span
									className={clsx(
										"badge",
										slotLabel === "C" ? "text-bg-primary" : "text-bg-secondary",
									)}
								>
									{slotLabel}
								</span>
							) : (
								<span className="fw-bold">{slotLabel2}</span>
							)}
							{naturalPos !== ratingPos2 ? (
								<span
									className={
										validPositions.includes(naturalPos)
											? "text-body-secondary"
											: "text-danger"
									}
								>
									{" "}
									({naturalPos})
								</span>
							) : null}
							{ovr !== undefined ? <> · {ovr} ovr</> : null}
						</div>
						<div className="text-nowrap small text-body-secondary">
							{statsLine}
						</div>
					</div>
				</div>
			</div>
		);
	};

	return (
		<div>
			{editable ? (
				<p className="text-body-secondary">
					Click a player, then click another player to swap them.
				</p>
			) : null}
			<div className="d-flex flex-column gap-2">
				{range(numLines).map((line) => (
					<div className="d-flex align-items-center" key={line}>
						{showLineNumbers ? (
							<div
								className="fs-4 text-body-secondary me-2"
								style={{ width: 20 }}
							>
								{line + 1}
							</div>
						) : null}
						<div className="d-flex flex-wrap gap-2">
							{displayOrder.map((slotIndex) =>
								renderCard(
									line * ratingPositions.length + slotIndex,
									slotLabels[slotIndex],
									ratingPositions[slotIndex],
								),
							)}
						</div>
					</div>
				))}
			</div>
			{players.length > numStarters ? (
				<>
					<div className="mt-3 mb-2 fw-bold">Scratches</div>
					<div className="d-flex flex-wrap gap-2">
						{range(numStarters, players.length).map((i) => renderCard(i))}
					</div>
				</>
			) : null}
		</div>
	);
};
