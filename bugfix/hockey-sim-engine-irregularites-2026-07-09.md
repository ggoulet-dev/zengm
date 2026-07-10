# Audit du moteur GameSim.hockey — irrégularités (2026-07-09)

Méthode : lecture directe complète de `src/worker/core/GameSim.hockey/index.ts` (2591 lignes) et des fichiers annexes (`PenaltyBox.ts`, `PlayByPlayLogger.ts`, `penalties.ts`, `getCompositeFactor.ts`, `getStartingAndBackupGoalies.ts`, `getPlayers.ts`), suivie d'un audit multi-agents (40 agents) avec vérification adversariale (2-3 votes indépendants par trouvaille, plusieurs avec repro empirique via vitest jetables). Les désaccords entre agents ont été tranchés manuellement (notamment via `git log -p` / `git blame`).

Statut : **points 1 à 10 corrigés le 2026-07-10** (workflow multi-agents : application + vérification adversariale par fix + typecheck + suite hockey complète, 103 tests verts). Fix 3 appliqué en variante minimale (`r = Math.min(r, 0.999)`) — la compression multiplicative avec recalibration des boosts reste une piste de suivi. Point 11 (plafond ovr 125→99) toujours en attente de décision.

---

## Bugs confirmés (impact réel sur le jeu)

### 1. Désynchronisation du nombre de patineurs en prolongation 3c3 — `index.ts:2136` — sévérité **HAUTE**

Quand une pénalité expire (`updatePlayersOnIce({type:"penaltyOver"})`), le code ne touche que l'équipe qui vient de récupérer son joueur. En 5c5 c'est correct. Mais en 3c3, `getThreeOnThreeComposition` calcule le nombre de patineurs d'une équipe à partir du **compteur de boîte de pénalité de l'adversaire**, pas du sien. Résultat vérifié empiriquement : à la fin d'une pénalité en OT 3c3, l'équipe punie récupère un patineur fantôme (elle n'en avait jamais perdu, puisque son propre roster de 3 est déjà reconstruit sans le joueur puni) ET l'équipe adverse garde son attaquant supplémentaire indéfiniment. Les deux équipes se retrouvent à 4 joueurs simultanément, boîte vide — un état impossible en LNH.

**Fix suggéré** : dans la branche `penaltyOver`, si `this.threeOnThree`, recalculer les deux équipes via `getThreeOnThreeComposition`/`pickThreeOnThreeSkaters` au lieu de faire un simple `push`. Noter aussi que `PenaltyBox.checkIfPenaltiesOver` appelle `onPenaltyOver` depuis l'intérieur d'un callback `Array.prototype.filter`, avant que `this.players[t]` soit réassigné — donc `penaltyBox.count(t)` est périmé pendant le callback ; il faudrait retirer l'entrée avant d'invoquer le callback.

### 2. `probBlock` jamais plafonné — `index.ts:1210` — sévérité **HAUTE**

Contrairement à `savePercentage` qui est explicitement bornée `[0,1]` via `helpers.bound`, `probBlock` (probabilité qu'un tir soit bloqué) ne l'est pas. Avec le plafond d'ovr à 125 et le multiplicateur `synergyRatio ** synergyFactor` non borné dans `getCompositeFactor`, une unité défensive d'élite face à une 4e ligne faible peut pousser `probBlock` au-delà de 1 → tous les tirs sont bloqués de façon déterministe, plus aléatoire du tout.

Repro empirique confirmé : unité défensive à ovr 120 / blocking 0.95 vs unité offensive à ovr 15 / blocking 0.1 → `probBlock = 2.81`.

**Fix suggéré** : `probBlock = helpers.bound((SHOT_BLOCK_BASE + SHOT_BLOCK_RANGE * this.team[this.d].compositeRating.blocking) * g.get("blockFactor"), 0, 1);` — idéalement aussi borner le retour de `getCompositeFactor.ts` à la racine, puisque `isGiveaway`/`isTakeaway` consomment les mêmes composite ratings non bornées.

### 3. Le `r` boosté (avantage numérique, 3c3, filet vide) peut dépasser 1 → but garanti peu importe le talent du gardien — `index.ts:1186-1210` — sévérité **HAUTE**

Le tirage `r` partagé (qui décide bloqué/raté/arrêté/but) se fait booster additivement selon la situation : +0.12 en 5c3, +0.05 en 5c4, +0.06 en 3c3, etc. Rien n'empêche `r` de dépasser 1, alors que `savePercentage` plafonne à 0.99.

Repro empirique : `Math.random()` fixé à 0.95, gardien avec `compositeRating.goalkeeping = 1` (maximum possible). En 5c5, `doShot()` retourne `"save"`. Avec les mêmes valeurs mais `threeOnThree = true`, `r = 0.95 + 0.06 = 1.01 > savePercentage (~0.99)` → `doShot()` retourne `"goal"`, un but garanti et impossible à arrêter, peu importe le talent du gardien. Comme les 3c3/avantages numériques sont des situations courantes (pas dégénérées), ça touche environ 5-12 % des tirs dans ces contextes à chaque partie, systématiquement.

**Fix suggéré** : remplacer les `r += boost` par une compression multiplicative du « gap » restant, ex. `r = 1 - (1 - r) * (1 - boost)`, pour que `r` ne puisse jamais atteindre/dépasser 1. Nécessitera une recalibration des grandeurs de boost (0.05/0.12/0.06) contre les mêmes cibles PP%/taux de fin d'OT déjà documentées dans les commentaires du fichier. Fix minimal alternatif (ne corrige pas le biais, juste le dépassement) : `r = Math.min(r, 0.999)` juste avant le test de `probBlock`.

### 4. `noPullGoalie` ne retire pas le bon joueur — `index.ts:2222` — sévérité **MOYENNE** (trouvé indépendamment 2 fois)

Quand le gardien revient au filet après avoir été retiré, le code calcule `sub` (le patineur à sortir de la glace) via une chaîne de fallback : `C[1] ?? W.at(-1) ?? C.at(-1) ?? D.at(-1)`. Mais ensuite il exécute inconditionnellement `this.playersOnIce[t].C = this.playersOnIce[t].C.slice(0, 1)`, peu importe d'où vient réellement `sub`. Si `sub` est un ailier ou un défenseur, il n'est jamais réellement retiré des tableaux W ou D → l'équipe joue avec un 6e patineur illégal jusqu'au prochain vrai changement de trio (jusqu'à ~0.7-1 minute de jeu plus tard).

Repro empirique : équipe en avantage numérique + filet vide (C a 2 joueurs) → pénalité mineure prise pendant que le filet est vide → `doLineChange` reconstruit C=1/W=2 (le push de l'attaquant supplémentaire ne se fait que si `penaltyBoxCount === 0`) → le gardien revient, `sub` résout à `W.at(-1)` → jamais retiré → 6 joueurs sur la glace (1G + 1C + 2W + 2D) alors que l'équipe purge encore une pénalité active.

**Fix suggéré** :

```ts
this.playersOnIce[t].C = this.playersOnIce[t].C.filter((p) => p !== sub);
this.playersOnIce[t].W = this.playersOnIce[t].W.filter((p) => p !== sub);
this.playersOnIce[t].D = this.playersOnIce[t].D.filter((p) => p !== sub);
```

(`sub` ne peut être que dans un seul des trois tableaux, donc ceci est un no-op correct sur les deux autres dans tous les cas de fallback.)

### 5. `checkPullGoalie` ne vérifie que l'équipe en possession en temps réglementaire — `index.ts:798` — sévérité **MOYENNE-HAUTE**

Contrairement à `simOvertime()` (lignes 858-859) et au bloc « but marqué » de `simPossession()` (lignes 1734-1735), qui vérifient les deux équipes, la boucle principale de `simRegulation()` n'appelle `checkPullGoalie` que pour `this.o` (l'équipe en possession). `checkGoalieHook(0)` et `checkGoalieHook(1)` sont, eux, bien appelés pour les deux équipes à chaque tick — l'asymétrie ressemble à un oubli de copier-coller.

Comme la possession ne coïncide pas forcément avec qui tire de l'arrière, l'équipe menée peut rester « en défense » (`this.d`) plusieurs ticks d'affilée sans jamais être évaluée pour le retrait de son gardien — exactement dans la fenêtre des 2-3 dernières minutes où c'est pertinent (`shouldPullGoalie` exige `period === numPeriods` et `clock <= 2` ou `<= 3`).

Repro empirique sur 300 essais forcés (3e période, en retard par 1 but, horloge à 3:00, boucle de tick réelle rejouée) : retrait tardif ou jamais déclenché dans 41 % des essais, délai moyen ~30 s, pire cas ~2 minutes de jeu perdues avant que le retrait se déclenche. Un run de contrôle ajoutant `checkPullGoalie(this.d)` élimine complètement l'effet (0/100 retraits tardifs).

**Fix suggéré** :

```ts
this.checkPullGoalie(this.o);
this.checkPullGoalie(this.d);
this.checkGoalieHook(0);
this.checkGoalieHook(1);
```

(actuellement seule la première ligne existe à la ligne 798)

### 6. PPO sous-compté sur les pénalités majeures multi-buts — `index.ts:330` — sévérité **MOYENNE**

`PenaltyBox.goal()` implémente correctement la règle LNH citée dans son propre commentaire : « après N buts marqués pendant [une pénalité majeure], ça compte pour N+1 avantages numériques » (les majeures n'écourtent jamais sur un but, donc plusieurs buts peuvent s'accumuler avant l'expiration). Mais le callback `onPenaltyOver` dans le constructeur de `GameSim` fait :

```ts
if (ppo > 0) {
	const t2 = t === 0 ? 1 : 0;
	this.recordStat(t2, undefined, "ppo", 1);
}
```

— la valeur `1` est codée en dur au lieu d'utiliser la vraie valeur `ppo` déstructurée. Une majeure avec 2 buts marqués pendant (donc `ppo = 3`) ne compte que 1 avantage numérique au lieu de 3, ce qui sous-compte le stat `ppo` de l'équipe et gonfle artificiellement son % d'avantage numérique affiché (`ppG / ppo`).

Repro empirique confirmé via `PenaltyBox` isolé (ajout d'une pénalité majeure, `advanceClock` + `goal()` x2 pendant qu'elle est active, puis expiration) : le callback reçoit bien `ppo: 3`.

**Fix suggéré** : `this.recordStat(t2, undefined, "ppo", ppo);` (au lieu de `1`) à la ligne 330.

### 7. Risque de NaN si `synergyRatio` a un dénominateur nul — `index.ts:1793` et `index.ts:1306` — sévérité **MOYENNE** (cas limite)

Contrairement à `getCompositeFactor.ts` qui a un garde explicite (`if (denominator === 0) return 0`), le ratio `this.team[t].synergy.reb / this.team[t2].synergy.reb` n'a aucune protection contre un dénominateur nul. Se produit si les joueurs sur la glace ont un `ovr` de 0 des deux côtés — un piège déjà documenté dans vos propres fichiers de test (« ovrs sont tous à 0 sans `develop()` »). Le NaN résultant se propage silencieusement dans toutes les composite ratings de l'équipe (`helpers.bound` ne filtre pas NaN).

**Fix suggéré**, aux deux emplacements (mêmes principe que le garde déjà présent dans `getCompositeFactor.ts`) :

```ts
const synergyRatio =
	this.team[t2].synergy.reb === 0
		? 1
		: this.team[t].synergy.reb / this.team[t2].synergy.reb;
```

### 8. Une mise en échec qui dégénère en bagarre saute le jet de blessure — `index.ts:914` — sévérité **BASSE**

Dans `doHit()`, `this.recordStat(t, hitter, "hit", 1)` et l'événement de mise en échec sont toujours enregistrés, mais la fonction retourne (`return true`) dès que `checkFight()` renvoie `true`, **avant** d'atteindre l'appel à `injuries({type: "hit", ...})`. Comme la probabilité de bagarre augmente avec la note « enforcer » des deux joueurs, les mises en échec les plus dures (celles entre gros enforcers, donc les plus susceptibles de dégénérer en bagarre) ont **moins** de risque de blessure que les mises en échec ordinaires — l'inverse de l'intuition.

**Fix suggéré** : déplacer l'appel à `injuries()` avant le `if (this.checkFight(...))`, ou l'exécuter inconditionnellement autour du retour anticipé.

### 9. Le logger play-by-play du hockey ignore le flag `active` — `PlayByPlayLogger.ts:177` — sévérité **MOYENNE** (perf)

Contrairement aux loggers basketball et football, qui font `if (this.active) { this.playByPlay.push(...); }`, celui du hockey (`HockeyPlayByPlayLogger.logEvent()`) pousse chaque évènement inconditionnellement sur `this.playByPlay`, même pour les matchs simulés en masse (non suivis en direct — la grande majorité des matchs lors d'une simulation multi-saisons). Le tableau construit est de toute façon jeté ensuite (`getPlayByPlay()` retourne `undefined` si `!active`), donc c'est du gaspillage pur d'allocation/GC à l'échelle où tourne ce fork (harnais de simulation multi-saisons type `franchise10yr.hockey.test.ts`).

**Fix suggéré** : `if (this.active) { this.playByPlay.push(event2); }` — laisser le calcul de `scoringSummary` inconditionnel (comme pour le football).

### 10. Texte de bagarre codé en dur — `src/ui/util/processLiveGameEvents.hockey.tsx:64` — sévérité **BASSE**

« Five minutes each for fighting » est une chaîne fixe plutôt que dérivée de `penaltyTypes.major.minutes` (la vraie source de vérité pour la durée d'une majeure, y compris les bagarres). Si cette constante est un jour rebalancée — elle gouverne aussi toutes les autres pénalités majeures (mise en échec par derrière, charge, etc.) — le texte affiché divergera silencieusement du vrai total de PIM enregistré dans le box score.

**Fix suggéré** : ajouter un champ `minutes` à l'événement `"fight"` dans `PlayByPlayEventInput`, le peupler dans `doFight()` avec `penaltyTypes[fightPenalty.type].minutes`, et interpoler ce champ dans le texte au lieu du « Five » codé en dur.

### 11. Plafond d'overall à 125 au lieu de 99 — `ovr.hockey.ts:100` et `develop.ts:31` — sévérité **MOYENNE** (décision produit, pas un bug de logique)

Le calcul d'overall d'un joueur de hockey est explicitement borné à 125 au lieu du standard 99 utilisé par les autres sports du projet (`ovr.football.ts:144` et `ovr.baseball.ts:145` bornent à 100 ; basketball suit la même convention) :

```ts
// ovr.hockey.ts:97-100
// Truly dominant players are allowed to exceed 100. The underlying ratings
// are capped at 100, so the formula naturally tops out around ~121 for a
// skater with maxed ratings; the upper bound here is just a safety rail.
r = helpers.bound(Math.round(r), 0, 125);
```

Ce plafond à 125 avait été introduit délibérément dans ce fork pour laisser plus de place à la différenciation des joueurs dominants (voir mémoire projet « Plafond ovr >100 & talent draft hockey »). Le plafond du potentiel projeté (`MAX_POT`) a été synchronisé en conséquence :

```ts
// develop.ts:24-32
// Upper bound for a projected potential. Must stay in sync with the per-sport
// ovr cap (see ovr.SPORT.ts). Hockey lets dominant players exceed 100, so its
// potential ceiling is raised to match.
const MAX_POT = bySport({
	baseball: 100,
	basketball: 100,
	football: 100,
	hockey: 125,
});
```

**Décision demandée** : ramener le plafond du hockey à 99 (le standard des autres sports du jeu), et non 125.

**Portée du changement** (à valider avant d'implémenter, vu l'ampleur potentielle) :

- `ovr.hockey.ts:100` — changer `125` → `99` (ou `100`, à trancher — les autres sports utilisent `100` comme borne mais le commentaire fait référence à un plafond "99 façon jeux de sport", à clarifier avec l'utilisateur).
- `develop.ts:31` — `MAX_POT.hockey` doit rester synchronisé avec le nouveau plafond (cf. commentaire ligne 24-26 qui l'exige explicitement).
- Effet en cascade probable sur tout ce qui a été calibré autour du plafond à 125 lors du travail précédent (voir mémoire « Plafond ovr >100 & talent draft hockey ») : la refonte des gardiens, le boost de développement des jeunes patineurs, et la synchronisation pot/potEstimator devront être revérifiés, puisqu'ils ont été calibrés en tenant compte d'un plafond à 125 (pic réel du potEstimator à 85-103, joueurs blue-chip en haut de draft à ~81-90, etc.). Redescendre le plafond à 99 sans retoucher ces calibrations risque de compresser artificiellement l'échelle de talent (des joueurs visés pour ~110-120 se retrouveraient tous écrasés à 99).

---

## Rejeté après vérification (pour transparence)

- **`isGiveaway`/`isTakeaway` formule identique** (`index.ts:1027-1059`) : les agents étaient divisés (2 contre 1 sur « pas un bug »). Tranché manuellement via `git log -p` : c'est un correctif **intentionnel** de l'auteur original de ZenGM (commit `540fa13b6`, « Fix a couple game sim logic errors », 2 mars 2021), qui a délibérément aligné `isGiveaway` sur la formule d'`isTakeaway` — ce n'est pas un copier-coller accidentel. Rien à corriger côté logique ; au mieux une note de calibration (`giveawayFactor`/`takeawayFactor` sont actuellement à parité=1 et pourraient être décorrélés si on veut différencier le ratio give/take).

- **`getStartingAndBackupGoalies` ignore le `starter` injury-aware dans le fallback** (`getStartingAndBackupGoalies.ts:33`) : réfuté à l'unanimité (0/3) — neutralisé en aval par le filtre d'injuries général de `setLines()` (le réordonnancement `[starter, backup, ...rest]` est un no-op d'identité dans cette branche, et `this.backupGoalies[t]` a son propre filtre `!p.injured` indépendant). Un agent a noté un vrai bug **ailleurs**, dans `src/worker/views/schedule.ts:368`, où le retour brut de la fonction est utilisé sans re-filtrage en aval pour l'affichage du « partant probable » — mineur, hors scope du moteur de simulation.

- **`checkGoalieHook` jamais appelé en prolongation** (`index.ts` — absent de `simOvertime()`) : verdict partagé (1 confirmé / 1 réfuté). Vérifié manuellement : la mort subite en OT casse la boucle dès qu'un but est marqué (`if (pts[0] !== pts[1]) break;` avant même `advanceClock()`), donc le scénario redouté (« le gardien encaisse 1-2 buts de plus en OT sans jamais être évalué pour un changement ») est structurellement impossible — un seul but termine la partie. Probablement pas exploitable en pratique, mais à surveiller si le format de l'OT change un jour (ex. retour à un format non-mort-subite).

- **`getPlayerFromNextLine` dernier recours ignore le filtre de boîte de pénalité** (`index.ts:1900-1904`) : verdict partagé (1 confirmé / 1 réfuté). Le code fait bien ce qui est décrit (retourner un joueur encore en pénalité en tout dernier recours), mais il faudrait que **tous** les joueurs du roster à une position (~24-26 joueurs, blessés inclus) soient simultanément indisponibles pour l'atteindre — jugé peu probable en jeu normal. Robustesse mineure, pas urgent.

---

## Prochaine étape proposée

Corriger les points 1 à 9 (les trois à sévérité haute en premier), en commits séparés et bien identifiés pour ne pas se mélanger avec le reste du travail en cours sur la branche `tux-hockey-improvement`.
