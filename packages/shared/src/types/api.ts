import { z } from "zod";
import { nameAllowed, nameProblem } from "../rules/names.js";

/** Every chosen name (tribe, game, alliance) goes through the same filter, and the refusal says why. */
const checkName = (s: string, ctx: z.RefinementCtx) => {
  const problem = nameProblem(s);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
};
import { balance } from "../config/balance.js";

/** Every API response carries the server time so clients can compute countdowns from an offset. */
export const healthResponse = z.object({
  ok: z.literal(true),
  serverTime: z.string(),
  version: z.string(),
  /** True when the server allows time-skips and other dev-only actions. */
  devTools: z.boolean().default(false),
});
export type HealthResponse = z.infer<typeof healthResponse>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Letters, digits, spaces, _ and -, starting and ending with a letter or digit; one space at a time. */
export const DISPLAY_NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}_-]|[ ](?=[\p{L}\p{N}_-]))*[\p{L}\p{N}]$|^[\p{L}\p{N}]{2}$/u;
export const RESERVED_NAMES = ["admin", "administrator", "moderator", "mod", "system", "last thaw", "lastthaw", "staff", "support"];
export const registerBody = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  displayName: z
    .string()
    .trim()
    .min(2)
    .max(24)
    .transform((s) => s.normalize("NFKC"))
    .refine((s) => DISPLAY_NAME_RE.test(s), "use letters, digits, spaces, _ or -, starting and ending with a letter or digit")
    .refine((s) => !RESERVED_NAMES.includes(s.toLowerCase()), "that name is reserved")
    .superRefine(checkName),
});
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s.length ? s : null))
    .nullable()
    .optional();

/** Profile settings: every field optional so the client can send only what changed. The tribe name is fixed at signup. */
export const updateProfileBody = z.object({
  tagline: optionalText(80),
  bio: optionalText(600),
  location: optionalText(60),
  /** The one-time tribe name pick for invited accounts (refused otherwise). */
  displayName: registerBody.shape.displayName.optional(),
});
export const changePasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(200) });

export const loginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
/** Either the link's token, or the six-digit code from the mail typed in while logged in. */
export const verifyBody = z.object({ token: z.string().min(10).optional(), code: z.string().regex(/^\d{6}$/).optional() }).refine((b) => !!b.token || !!b.code, { message: "a token or a code is needed" });
export const forgotBody = z.object({ email: z.string().email() });
export const resetBody = z.object({ token: z.string().min(10), password: z.string().min(8).max(200) });

export const userView = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  emailVerified: z.boolean(),
  isAdmin: z.boolean().default(false),
  /** May join and create matches: true once the email is verified. */
  approved: z.boolean().default(false),
  /** May still pick a tribe name (invited accounts, once). */
  canRename: z.boolean().default(false),
  tagline: z.string().nullable().default(null),
  bio: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  /** ISO date the account was created. */
  createdAt: z.string().nullable().default(null),
});
export type UserView = z.infer<typeof userView>;

// ---------------------------------------------------------------------------
// Matches and lobby
// ---------------------------------------------------------------------------

export const matchStatus = z.enum(["lobby", "running", "finished"]);
export type MatchStatus = z.infer<typeof matchStatus>;

export const matchSummary = z.object({
  id: z.string(),
  /** Readable address for links; the UUID when an old match has none. */
  slug: z.string().default(""),
  name: z.string(),
  status: matchStatus,
  speed: z.number(),
  startsAt: z.string(),
  endsAt: z.string(),
  humanPlayers: z.number(),
  /** Seats taken: humans in the lobby; humans plus AI tribes once the match runs (always full). */
  players: z.number().default(0),
  maxPlayers: z.number(),
  joined: z.boolean(),
  /** My player id in this match, if joined. */
  playerId: z.string().nullable(),
  capitalRegionId: z.string().nullable(),
  /** Tournaments are scheduled and ranked; public and private games are player-made. */
  kind: z.enum(["tournament", "public", "private"]).default("public"),
  /** The invite code, shown only to the game's creator. */
  inviteCode: z.string().nullable().default(null),
  createdByMe: z.boolean().default(false),
  /** The game's resource multiplier (1 = normal). */
  resourceMult: z.number().default(1),
  /** Tournaments: how many have registered, whether I have, and when joining opens. */
  registrations: z.number().default(0),
  registered: z.boolean().default(false),
  joinOpensAt: z.string().nullable().default(null),
});
export const joinMatchBody = z.object({ inviteCode: z.string().trim().max(32).optional() });
export const joinByCodeBody = z.object({ code: z.string().trim().min(4).max(32) });
export type MatchSummary = z.infer<typeof matchSummary>;

export const createMatchBody = z.object({
  name: z.string().trim().min(2).max(40).superRefine(checkName),
  speed: z.number().int().min(1).max(1000),
  startsInMinutes: z.number().int().min(0).max(60 * 24 * 14),
  /** Exact start (ISO); wins over startsInMinutes when given. */
  startsAt: z.string().datetime().optional(),
  /** Tournament (admins only; the ranked, scheduled kind), public (anyone may join) or private (joiners need the invite code). */
  kind: z.enum(["tournament", "public", "private"]).optional(),
  /** AI tribes are added until this many players exist. Default from balance. */
  aiFillTo: z.number().int().min(0).max(balance.match.maxAiTribes).optional(),
  /** Neutral tribes scattered on the map. Default from balance. */
  neutralTribes: z.number().int().min(0).max(300).optional(),
  /** AI difficulty: a single tier or a mix. */
  aiDifficulty: z.enum(["mixed", "easy", "medium", "hard"]).optional(),
  /** Everything gathered or extracted is scaled by this, independent of speed. 1 is normal; tournaments are always 1. */
  resourceMult: z.number().min(1).max(10).optional(),
});

export const pickStartBody = z.object({ regionId: z.string() });
export const setCapitalBody = z.object({ regionId: z.string() });
/** Rally: every stationed military unit marches to the capital; optionally armies on missions are recalled too. */
export const rallyBody = z.object({ includeMissions: z.boolean().default(false) });
/** Upgrade haulers stationed in a region: caravans to wagons, caravans or wagons to trains. */
export const convertBody = z.object({ from: z.string(), to: z.string(), qty: z.number().int().min(1) });
export const assignBody = z.object({
  food: z.number().min(0).max(1),
  wood: z.number().min(0).max(1),
  stone: z.number().min(0).max(1),
});
export const timeSkipBody = z.object({ seconds: z.number().int().min(1).max(60 * 60 * 24 * 40) });

// ---------------------------------------------------------------------------
// Match state as seen by one player (fog of war applied server-side)
// ---------------------------------------------------------------------------

export const assignment = z.object({ food: z.number(), wood: z.number(), stone: z.number() });
export const specialStock = z.object({ copper: z.number(), tin: z.number(), iron: z.number(), horses: z.number() });

export const ownedRegionView = z.object({
  regionId: z.string(),
  ownerPlayerId: z.string(),
  popWorkers: z.number(),
  popSoldiers: z.number(),
  popOccupiers: z.number(),
  food: z.number(),
  wood: z.number(),
  stone: z.number(),
  special: specialStock,
  assignment,
  storage: z.object({ food: z.number(), wood: z.number(), stone: z.number() }),
  capacity: z.number(),
  yieldMult: z.object({ food: z.number(), wood: z.number(), stone: z.number() }),
  extract: z.record(z.string(), z.number()),
  buildings: z.record(z.string(), z.number()),
  units: z.record(z.string(), z.number()),
  effects: z.object({
    defense: z.number(),
    loyalty: z.number(),
    researchSpeed: z.number(),
    trainSpeed: z.number(),
    protect: z.number(),
    harbor: z.boolean(),
  }),
  loyalty: z.number(),
  /** Taken by force: needs occupiers (10 per 100 people) to stay loyal. */
  conquered: z.boolean().default(false),
  /** Production multiplier from the ice taper: 1 untouched, down to 0.25 before freezing. */
  iceFactor: z.number().default(1),
  /** Population growth multiplier from techs. */
  growthMult: z.number().default(1),
  frozen: z.boolean(),
  /** Evacuated and empty: no growth or production until people move back in. */
  evacuated: z.boolean().default(false),
  /** Blizzard until (ISO), or null. */
  stormUntil: z.string().nullable().default(null),
  /** Sickness until (ISO), or null. */
  plagueUntil: z.string().nullable().default(null),
  /** Thaw pocket: the ice passes this region by until (ISO), or null. */
  thawUntil: z.string().nullable().default(null),
  /** Rich find: doubled resource and until when. */
  boom: z.object({ resource: z.string(), until: z.string() }).nullable().default(null),
  /** Server time the amounts above are valid for. Clients project forward from here. */
  asOf: z.string(),
  rates: z.object({ food: z.number(), wood: z.number(), stone: z.number(), population: z.number(), starving: z.boolean() }),
  isCapital: z.boolean(),
});
export type OwnedRegionView = z.infer<typeof ownedRegionView>;

export const jobView = z.object({
  id: z.string(),
  kind: z.enum(["build", "research", "train", "mission", "ice_step", "win_hold", "match_end", "storm", "merc_expire"]),
  regionId: z.string().nullable(),
  refId: z.string().nullable(),
  level: z.number().nullable(),
  qty: z.number().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  /** Build jobs waiting for materials to arrive by caravan: what is still owed. */
  waitingFor: z.record(z.string(), z.number()).nullable().default(null),
});
export type JobView = z.infer<typeof jobView>;

export const missionKind = z.enum(["raid", "conquer", "reinforce", "move", "transport", "scout", "settle", "relocate", "patrol", "expedition"]);
export type MissionKind = z.infer<typeof missionKind>;

export const sendArmyBody = z.object({
  mission: missionKind,
  targetRegionId: z.string(),
  units: z.record(z.string(), z.number().int().min(0)),
  /** People to carry as occupiers (conquer) or settlers (move/reinforce). */
  people: z.number().int().min(0).default(0),
  cargo: z.record(z.string(), z.number().min(0)).default({}),
});

export const armyView = z.object({
  id: z.string(),
  playerId: z.string(),
  mission: missionKind,
  originRegionId: z.string(),
  targetRegionId: z.string(),
  units: z.record(z.string(), z.number()),
  cargo: z.record(z.string(), z.number()),
  status: z.enum(["outbound", "returning", "done"]),
  departsAt: z.string(),
  arrivesAt: z.string(),
  returnsAt: z.string().nullable(),
  /** Region ids from origin to target. */
  path: z.array(z.string()).default([]),
  /** Why it turned back, when returning early. */
  note: z.string().nullable().default(null),
  /** Sea lane a patrol holds, as "a|b" (region ids sorted). */
  lane: z.string().nullable().default(null),
  /** A collecting convoy's remaining itinerary: pickups then the destination. */
  stops: z.array(z.object({ regionId: z.string(), routeId: z.string().nullable(), take: z.record(z.string(), z.number()), done: z.boolean().optional() })).default([]),
});
export type ArmyView = z.infer<typeof armyView>;

/** What a defender is told about an army heading their way. */
export const incomingView = z.object({
  id: z.string(),
  mission: missionKind,
  targetRegionId: z.string(),
  fromPlayerId: z.string(),
  fromPlayerName: z.string(),
  arrivesAt: z.string(),
  /** Rough size only; the exact composition stays hidden unless a watchtower has seen it. */
  size: z.number(),
  /** The exact force, once it has reached a region next to one of yours with a Watchtower. */
  units: z.record(z.string(), z.number()).optional(),
});
export type IncomingView = z.infer<typeof incomingView>;

export const routePreview = z.object({
  path: z.array(z.string()),
  seconds: z.number(),
  usesSea: z.boolean(),
});

export const routeMode = z.enum(["fixed", "share"]);
export const createRouteBody = z.object({
  toRegionId: z.string(),
  mode: routeMode,
  /** Fixed mode: goods per trip. */
  load: z.record(z.string(), z.number().min(0)).default({}),
  /** Share mode: fraction of gross production since the last trip. */
  share: z.number().min(0).max(1).default(0),
  caravans: z.number().int().min(1).max(50),
  everyHours: z.number().min(0.5).max(48),
  /** Stock-up: deliver these totals (fixed mode), then the route removes itself. May target a region my settlers are on their way to. */
  target: z.record(z.string(), z.number().min(0)).optional(),
});
export const tradeRouteView = z.object({
  id: z.string(),
  fromRegionId: z.string(),
  toRegionId: z.string(),
  mode: routeMode,
  load: z.record(z.string(), z.number()),
  share: z.number(),
  caravans: z.number(),
  everyHours: z.number(),
  enabled: z.boolean(),
  nextAt: z.string(),
  lastResult: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  /** Stock-up routes deliver `target` in total, then remove themselves. */
  target: z.record(z.string(), z.number()).nullable().default(null),
  delivered: z.record(z.string(), z.number()).default({}),
  /** Materials routes: goods set aside at the origin, waiting for the haulers. */
  held: z.record(z.string(), z.number()).default({}),
});
export type TradeRouteView = z.infer<typeof tradeRouteView>;

/** Colonize an empty region, optionally stocking it from the source by caravan once founded. */
export const colonizeBody = z.object({
  targetRegionId: z.string(),
  settlers: z.number().int().min(1),
  /** Total food/wood/stone to deliver after the colony is founded (0 or omitted = none). */
  stock: z.record(z.enum(["food", "wood", "stone"]), z.number().min(0)).optional(),
  caravans: z.number().int().min(1).max(50).default(2),
});

export const buildBody = z.object({ buildingId: z.string() });
export const trainBody = z.object({ unitId: z.string(), qty: z.number().int().min(1).max(1000) });
export const researchBody = z.object({ techId: z.string() });

/** What a player knows about a region they do not own. */
export const NOTE_COLOURS = ["red", "amber", "green", "blue", "purple"] as const;
export type NoteColour = (typeof NOTE_COLOURS)[number];
export const regionNoteView = z.object({
  regionId: z.string(),
  text: z.string(),
  colour: z.enum(NOTE_COLOURS).nullable(),
  updatedAt: z.string(),
});
export type RegionNoteView = z.infer<typeof regionNoteView>;
export const regionNoteBody = z.object({
  text: z.string().max(500).default(""),
  colour: z.enum(NOTE_COLOURS).nullable().default(null),
});
export type RegionNoteBody = z.infer<typeof regionNoteBody>;

export const sightedRegionView = z.object({
  regionId: z.string(),
  ownerPlayerId: z.string().nullable(),
  ownerName: z.string().nullable(),
  population: z.number().nullable(),
  seenAt: z.string(),
  /** The region had Roads when last seen (allies: live). */
  roads: z.boolean().default(false),
  /** Strongest defensive building seen there (palisade, walls, fort, castle, arsenal, bunker), or null. */
  wall: z.string().nullable().default(null),
  /** A blizzard is blowing there now. */
  storm: z.boolean().default(false),
  /** The units standing there right now: seen from a Watchtower of yours next door. */
  units: z.record(z.string(), z.number()).optional(),
});

export const pactView = z.object({
  id: z.string(),
  kind: z.enum(["nap", "ceasefire", "tribute"]),
  aPlayerId: z.string(),
  bPlayerId: z.string(),
  status: z.string(),
  until: z.string().nullable(),
  terms: z.record(z.string(), z.unknown()).default({}),
});
export type PactView = z.infer<typeof pactView>;
export const proposePactBody = z.object({
  otherPlayerId: z.string().uuid(),
  kind: z.enum(["nap", "ceasefire", "tribute"]),
  resource: z.string().optional(),
  amount: z.number().int().min(1).max(1_000_000).optional(),
});
export const respondPactBody = z.object({ accept: z.boolean() });
export const mercenaryOfferView = z.object({
  id: z.string(),
  company: z.string(),
  unitId: z.string(),
  qty: z.number(),
  iron: z.number(),
  expiresAt: z.string(),
});
export type MercenaryOfferView = z.infer<typeof mercenaryOfferView>;
export const lastStandBody = z.object({ targetRegionId: z.string() });

/** Advisors: hired staff paid by the hour: Economic, Military, the Warden of the Thaw, and the Chancellor. */
export const advisorKind = z.enum(["economic", "military", "thaw", "chancellor"]);
export type AdvisorKind = z.infer<typeof advisorKind>;
export const advisorSettings = z.object({
  /** Minimum level wanted everywhere the building can stand; 0 or absent leaves it alone. */
  minLevels: z.record(z.string(), z.number().int().min(0).max(50)).default({}),
  /** Queue builds a region cannot pay for and let convoys bring the rest from other regions. */
  useOtherRegions: z.boolean().default(true),
  /** Set each region's worker shares between food, wood and stone from what the region and the empire need. */
  workers: z.boolean().default(true),
  /** Regions the advisor leaves alone. */
  skipRegions: z.array(z.string()).max(500).default([]),
  /** How people are moved: not at all, overflow from crowded regions to neighbours, or balanced across the empire. */
  population: z.enum(["off", "overflow", "balanced"]).default("overflow"),
  // Military: passive defends only; measured defends and takes the marked targets; aggressive also picks its own and raids.
  stance: z.enum(["passive", "measured", "aggressive"]).default("measured"),
  /** Regions to conquer, in order. */
  targets: z.array(z.string()).max(20).default([]),
  maxCampaigns: z.number().int().min(1).max(3).default(3),
  /** Soldiers wanted in every border region (passive doubles it; the capital doubles it again). */
  garrison: z.number().int().min(0).max(500).default(10),
  /** Queue Palisade, Walls and a Watchtower on exposed border regions. */
  fortify: z.boolean().default(true),
  /** No attack without a fresh sighting or a watchtower view. */
  scoutFirst: z.boolean().default(true),
  /** Aggressive only: raid rich weak neighbours with spare soldiers. */
  raids: z.boolean().default(true),
  // Warden of the Thaw: evacuate this many game hours before a region freezes; move the capital this many hours before.
  warningHours: z.number().int().min(6).max(120).default(24),
  capitalHours: z.number().int().min(12).max(168).default(48),
  /** Where evacuees go: the safest region of yours with a route, or the capital. */
  destination: z.enum(["safest", "capital"]).default("safest"),
  moveCapital: z.boolean().default(true),
  /** Settle free land on the warm side while regions are being lost. */
  settle: z.boolean().default(true),
  // Chancellor: research toward a goal, and the market.
  researchGoal: z.enum(["age", "hauling", "walls", "sea", "off"]).default("age"),
  /** List a store above this share of its cap, down to the sellDownTo share, at the fair price. */
  sell: z.boolean().default(true),
  sellAbove: z.number().min(0.5).max(0.98).default(0.8),
  /** Buy what waiting orders and the next research owe from the cheapest offer not above fair times overpay, keeping reserveShare of the capital's cap. */
  buy: z.boolean().default(true),
  overpay: z.number().min(1).max(3).default(1.25),
  reserveShare: z.number().min(0).max(0.9).default(0.3),
  /** His own open listings at once (the market allows ten per player). */
  maxOrders: z.number().int().min(1).max(10).default(3),
});
export type AdvisorSettings = z.infer<typeof advisorSettings>;
export const campaignStage = z.enum(["intel", "muster", "marching", "done", "failed"]);
export const campaignView = z.object({
  targetRegionId: z.string(),
  stage: campaignStage,
  stagingRegionId: z.string().nullable().default(null),
  need: z.object({ unit: z.string(), qty: z.number(), settlers: z.number(), siege: z.object({ unit: z.string(), qty: z.number() }).nullable().default(null) }).nullable().default(null),
  armyId: z.string().nullable().default(null),
  attempts: z.number().default(0),
  startedAt: z.string(),
  note: z.string().default(""),
});
export type CampaignView = z.infer<typeof campaignView>;
export const advisorTargetBody = z.object({ regionId: z.string(), add: z.boolean() });
export const advisorSuggestion = z.object({ regionId: z.string().nullable(), text: z.string() });
export type AdvisorSuggestion = z.infer<typeof advisorSuggestion>;
export const advisorReport = z.object({
  at: z.string(),
  queued: z.number(),
  moved: z.number().default(0),
  /** Regions whose worker shares were changed this pass. */
  rebalanced: z.number().default(0),
  // Military.
  trained: z.number().default(0),
  fortified: z.number().default(0),
  /** The most exposed border regions, worst first, with a line each. */
  exposed: z.array(z.object({ regionId: z.string(), exposure: z.number(), text: z.string() })).default([]),
  // Warden of the Thaw.
  evacuated: z.number().default(0),
  settled: z.number().default(0),
  /** Regions on the clock: freezing soonest first, with a line each. */
  clock: z.array(z.object({ regionId: z.string(), hoursLeft: z.number(), text: z.string() })).default([]),
  // Chancellor.
  researched: z.number().default(0),
  listed: z.number().default(0),
  bought: z.number().default(0),
  skipped: z.record(z.string(), z.number()).default({}),
  suggestions: z.array(advisorSuggestion).default([]),
});
export type AdvisorReport = z.infer<typeof advisorReport>;
export const advisorView = z.object({
  kind: advisorKind,
  hiredAt: z.string(),
  paidUntil: z.string(),
  /** The wage could not be met: the advisor has stopped until it is. */
  unpaid: z.boolean(),
  wage: z.record(z.string(), z.number()),
  settings: advisorSettings,
  lastPassAt: z.string().nullable(),
  lastReport: advisorReport.nullable(),
  /** Military: the campaigns in hand. */
  campaigns: z.array(campaignView).default([]),
});
export type AdvisorView = z.infer<typeof advisorView>;

export const refugeeOfferView = z.object({
  id: z.string(),
  regionId: z.string(),
  fromRegionId: z.string(),
  people: z.number(),
  food: z.number(),
  expiresAt: z.string(),
});
export type RefugeeOfferView = z.infer<typeof refugeeOfferView>;
export type SightedRegionView = z.infer<typeof sightedRegionView>;

export const playerPublic = z.object({
  id: z.string(),
  name: z.string(),
  isAi: z.boolean(),
  /** "easy" | "medium" | "hard" for AI tribes, null for humans. */
  aiLevel: z.string().nullable().default(null),
  age: z.number(),
  score: z.number(),
  regions: z.number(),
});

export const matchStateView = z.object({
  match: z.object({
    id: z.string(),
    name: z.string(),
    status: matchStatus,
    speed: z.number(),
    /** Everything gathered or extracted is scaled by this (1 = normal). */
    resourceMult: z.number().default(1),
    startsAt: z.string(),
    endsAt: z.string(),
    /** Match clock (server time plus any dev time skip), ISO. While paused this is the moment the pause began. */
    now: z.string(),
    clockOffsetSeconds: z.number(),
    pausedAt: z.string().nullable().default(null),
    /** Readable address of the match, for links and the canonical URL. */
    slug: z.string().default(""),
    finishedAt: z.string().nullable().default(null),
    winnerPlayerId: z.string().nullable().default(null),
    /** You created this game (not a tournament), so you may end it early. */
    createdByMe: z.boolean().default(false),
    tournament: z.boolean().default(false),
  }),
  me: z.object({
    playerId: z.string(),
    name: z.string(),
    capitalRegionId: z.string().nullable(),
    protectionUntil: z.string().nullable(),
    age: z.number(),
    techs: z.array(z.string()),
    allianceId: z.string().nullable(),
    allianceTag: z.string().nullable(),
  }),
  owned: z.array(ownedRegionView),
  sighted: z.array(sightedRegionView),
  players: z.array(playerPublic),
  /** Pending build/train jobs in my regions plus my research job, if any. */
  jobs: z.array(jobView),
  /** My armies in flight. */
  armies: z.array(armyView),
  /** Hostile armies heading for my regions. */
  incoming: z.array(incomingView),
  /** Unclaimed, empty regions bordering mine: settle targets. */
  frontier: z.array(z.string()).default([]),
  /** Every region in a blizzard right now, mine or not, for the map. */
  storms: z.array(z.string()).default([]),
  /** Thaw pockets anyone can see: region and until when. */
  thaws: z.array(z.object({ regionId: z.string(), until: z.string() })).default([]),
  /** Migrant columns waiting at my borders. */
  refugees: z.array(refugeeOfferView).default([]),
  /** Pacts, ceasefires and tribute demands I am part of (open, in force, or recently refused). */
  pacts: z.array(pactView).default([]),
  /** Mercenary companies for hire right now. */
  mercenaries: z.array(mercenaryOfferView).default([]),
  /** Advisors I have hired. */
  advisors: z.array(advisorView).default([]),
  /** The last stand is open: the ice is a day from the capital and it has not been used. */
  lastStand: z.object({ eligible: z.boolean(), used: z.boolean() }).default({ eligible: false, used: false }),
  /** Today's objective and who took yesterday's. */
  objective: z.object({ day: z.number(), label: z.string(), yesterday: z.object({ label: z.string(), playerId: z.string().nullable(), value: z.number() }).nullable() }).nullable().default(null),
  /** Open bounties anyone can claim by winning a battle against the region or player. */
  bounties: z.array(z.object({ id: z.string(), kind: z.enum(["region", "player"]), regionId: z.string().nullable(), playerId: z.string().nullable(), amount: z.record(z.string(), z.number()), reason: z.string(), expiresAt: z.string().nullable() })).default([]),
  /** My private notes and markers on regions. */
  notes: z.array(regionNoteView).default([]),
  /** My automated caravan routes. */
  routes: z.array(tradeRouteView).default([]),
  /** Player ids of my alliance mates (their regions are always visible). */
  allies: z.array(z.string()),
  /** An admin looking in from outside: every region, army and march is in view, and nothing can be done. */
  observer: z.boolean().default(false),
});
export type MatchStateView = z.infer<typeof matchStateView>;

export const startOption = z.object({
  regionId: z.string(),
  taken: z.boolean(),
});

// ---------------------------------------------------------------------------
// Realtime events (WebSocket). Payloads are hints; clients refetch state.
// ---------------------------------------------------------------------------

export const wsClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), matchId: z.string() }),
  z.object({ type: z.literal("unsubscribe"), matchId: z.string() }),
  z.object({ type: z.literal("ping") }),
  /** The player touched the page in the last half minute; time online counts only around these. */
  z.object({ type: z.literal("active") }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessage>;

export const wsServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), serverTime: z.string() }),
  z.object({ type: z.literal("pong"), serverTime: z.string() }),
  z.object({ type: z.literal("subscribed"), matchId: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({
    type: z.literal("event"),
    matchId: z.string(),
    kind: z.string(),
    at: z.string(),
    payload: z.unknown(),
  }),
]);
export type WsServerMessage = z.infer<typeof wsServerMessage>;

/** Event kinds published on match and player channels. */
export const EVENT_KINDS = [
  "match.started",
  "match.paused",
  "match.resumed",
  "match.finished",
  "region.updated",
  "player.joined",
  "time.skipped",
  "match.cancelled",
  "job.completed",
  "age.advanced",
  "message.new",
  "army.sent",
  "army.incoming",
  "army.arrived",
  "region.conquered",
  "alliance.updated",
  "chat.message",
  "trade.filled",
  "advisor.hired",
  "advisor.fired",
  "advisor.settings",
  "advisor.report",
  "advisor.targets",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// ---------------------------------------------------------------------------
// Milestone 5: alliances, chat and the market
// ---------------------------------------------------------------------------

export const createAllianceBody = z.object({
  name: z.string().trim().min(2).max(30).superRefine(checkName),
  tag: z.string().trim().min(2).max(5).regex(/^[A-Z0-9]+$/, "tag must be uppercase letters or digits").refine(nameAllowed, "that tag is not allowed"),
});
export const allianceInviteBody = z.object({ playerId: z.string() });
export const allianceIdBody = z.object({ allianceId: z.string() });
export const allianceKickBody = z.object({ playerId: z.string() });

export const allianceMemberView = z.object({
  playerId: z.string(),
  name: z.string(),
  role: z.string(),
  regions: z.number(),
  joinedAt: z.string(),
});
export const allianceView = z.object({
  id: z.string(),
  name: z.string(),
  tag: z.string(),
  leaderPlayerId: z.string(),
  members: z.array(allianceMemberView),
  regions: z.number(),
});
export type AllianceView = z.infer<typeof allianceView>;
export const allianceInviteView = z.object({
  id: z.string(),
  allianceId: z.string(),
  name: z.string(),
  tag: z.string(),
  createdAt: z.string(),
});
export const alliancesResponse = z.object({
  alliances: z.array(allianceView),
  mine: allianceView.nullable(),
  myRole: z.string().nullable(),
  invites: z.array(allianceInviteView),
});
export type AlliancesResponse = z.infer<typeof alliancesResponse>;

export const chatChannel = z.enum(["global", "alliance"]);
export const chatPostBody = z.object({ channel: chatChannel, body: z.string().trim().min(1).max(500) });
export const chatMessageView = z.object({
  id: z.string(),
  channel: z.string(),
  playerId: z.string(),
  playerName: z.string(),
  body: z.string(),
  sentAt: z.string(),
});
export type ChatMessageView = z.infer<typeof chatMessageView>;
export const chatResponse = z.object({ channel: z.string(), messages: z.array(chatMessageView) });
export type ChatResponse = z.infer<typeof chatResponse>;

export const tradeResource = z.enum(["food", "wood", "stone", "copper", "tin", "iron", "horses"]);
export type TradeResource = z.infer<typeof tradeResource>;
/** Rough worth of one unit of each resource, used only to refuse market orders that are gifts in disguise. */
export const RESOURCE_WORTH: Record<string, number> = { food: 1, wood: 1, stone: 1.2, copper: 20, tin: 25, iron: 30, horses: 15 };
/** Offers may be at most this many times more valuable than the ask, or the reverse. */
export const MARKET_MAX_RATIO = 20;

/** A round figure near n: two significant digits, so a suggestion reads like a price and not a calculation. */
export function round2(n: number): number {
  if (n < 10) return Math.max(1, Math.round(n));
  const mag = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

/** Fair trade: the amount of `give` worth as much as `amount` of `want`, by the market's own worth table. */
export function fairAmount(want: string, amount: number, give: string): number {
  return round2((amount * (RESOURCE_WORTH[want] ?? 1)) / (RESOURCE_WORTH[give] ?? 1));
}
export const createOrderBody = z.object({
  regionId: z.string(),
  offerResource: tradeResource,
  offerAmount: z.number().int().min(1).max(1_000_000),
  askResource: tradeResource,
  askAmount: z.number().int().min(1).max(1_000_000),
});
export const acceptOrderBody = z.object({ regionId: z.string() });
export const marketOrderView = z.object({
  id: z.string(),
  playerId: z.string(),
  playerName: z.string(),
  /** Only your own orders say which region they sit in. */
  regionId: z.string().nullable(),
  offerResource: tradeResource,
  offerAmount: z.number(),
  askResource: tradeResource,
  askAmount: z.number(),
  status: z.string(),
  createdAt: z.string(),
});
export type MarketOrderView = z.infer<typeof marketOrderView>;
export const marketResponse = z.object({ open: z.array(marketOrderView), mine: z.array(marketOrderView) });
export type MarketResponse = z.infer<typeof marketResponse>;
