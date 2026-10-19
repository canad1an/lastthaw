/**
 * Names people choose: tribe names, game names, alliance names and tags. Refused when they carry an
 * address or a pitch (that is advertising, not a name) or a slur or crude word. The check is on a
 * normalised form: lower case, look-alike digits and symbols turned back into letters, repeats collapsed,
 * so "fr33 cryp7o" and "F.U.C.K" are seen for what they are. Ordinary words that merely contain a
 * rude string (Cassandra, Scunthorpe, Cumberland) pass: the crude list matches whole words, and only a few
 * strings that never appear innocently are matched anywhere.
 */

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", $: "s", "!": "i", "|": "l", "+": "t", "(": "c" };

/** Lower case, look-alikes to letters, everything but letters and digits to spaces, runs of the same letter squeezed. */
export function normaliseName(name: string): string {
  const folded = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split("")
    .map((ch) => LEET[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return folded.replace(/(.)\1{2,}/g, "$1$1");
}

/** Addresses and the words of a pitch. Matched anywhere in the squeezed, space-free form. */
const ADVERTISING = [
  "http", "www", "dotcom", "dotnet", "dotorg", "dotio", "dotgg", "dotxyz", "dotco",
  "casino", "crypto", "bitcoin", "btc", "ethereum", "forex", "nft", "airdrop", "giveaway", "freemoney", "promo", "promocode", "discount", "coupon", "buynow", "cheap", "forsale", "onlyfans", "telegram", "whatsapp", "escort", "viagra", "cialis", "betting", "sportsbet", "1xbet", "bet365", "slots", "jackpot", "clickhere", "subscribe", "followme", "dmme", "earnmoney", "makemoney", "sugardaddy", "hookup", "porn", "xxx", "sexchat", "camgirl", "nude",
];

/** Crude words and slurs, matched as whole words in the normalised form. */
const CRUDE_WORDS = [
  "fuck", "fucker", "fucking", "motherfucker", "shit", "bullshit", "cunt", "cock", "dick", "dickhead", "pussy", "asshole", "arsehole", "bitch", "whore", "slut", "twat", "wanker", "bastard", "prick", "jizz", "cum", "anal", "rape", "rapist", "pedo", "paedo", "pedophile", "nazi", "hitler",
  "nigger", "nigga", "faggot", "fag", "dyke", "tranny", "retard", "retarded", "spic", "chink", "gook", "kike", "wetback", "raghead", "towelhead", "coon", "beaner",
];

/** Strings with no innocent use, matched anywhere. */
const CRUDE_ANYWHERE = ["nigg", "fagg", "fuck", "motherf", "pedophil", "paedophil", "hitler"];

const crudeWord = new RegExp(`\\b(${CRUDE_WORDS.join("|")})s?\\b`);

/** Why a chosen name is refused, or null when it is fine. */
export function nameProblem(name: string): string | null {
  // Spaced-out letters ("c u n t") are caught by testing the space-free forms as whole words too.
  // Two forms: repeats squeezed to a pair (so "coon" and "ass" keep their shape) and to a single letter (so "fuuuuck" reads as "fuck").
  const norm = normaliseName(name);
  const single = norm.replace(/(.)\1+/g, "$1");
  const forms = [norm, single];
  const squeezed = forms.map((f) => f.replace(/\s+/g, ""));
  if (/https?|www\.|\.(com|net|org|io|gg|xyz|co|app|dev|me|tv|ru|info|biz|site|online|shop|store|club)\b/i.test(name)) return "a name cannot be an address";
  if (ADVERTISING.some((w) => squeezed.some((s) => s.includes(w)))) return "a name cannot be an advertisement";
  if (CRUDE_ANYWHERE.some((w) => squeezed.some((s) => s.includes(w))) || [...forms, ...squeezed].some((f) => crudeWord.test(f))) return "that name is not allowed";
  return null;
}

/** For zod: true when the name passes. */
export const nameAllowed = (name: string): boolean => nameProblem(name) === null;
