import type { LibraryBranch } from "../connectors/types";

const NAME_NOISE = new Set(["the", "branch", "library", "public", "and"]);
const ADDRESS_WORDS: Record<string, string> = {
  avenue: "ave", av: "ave", street: "st", drive: "dr", road: "rd", boulevard: "blvd", place: "pl", court: "ct", lane: "ln", parkway: "pkwy", highway: "hwy", terrace: "ter", square: "sq",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th", sixth: "6th", seventh: "7th", eighth: "8th", ninth: "9th", tenth: "10th",
};
const tokens = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
export const nameKey = (text: string) => tokens(text).filter((word) => !NAME_NOISE.has(word)).join(" ");
export const addressKey = (text: string) => tokens(text).map((word) => ADDRESS_WORDS[word] ?? word).join(" ");

export function matchBranch(venue: string, branches: LibraryBranch[]): string | null {
  const segments = [venue, ...venue.split(",")];
  const names = new Set(segments.map(nameKey).filter(Boolean));
  const address = ` ${addressKey(venue)} `;
  for (const branch of branches) {
    if (names.has(nameKey(branch.name))) return branch.name;
    const street = addressKey(branch.address);
    if (street && address.includes(` ${street} `)) return branch.name;
  }
  return null;
}
