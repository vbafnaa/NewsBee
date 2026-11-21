export type BeePuzzle = { word: string; clue: string };

export function parseBeePuzzle(value: unknown): BeePuzzle {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("word" in value) || typeof value.word !== "string"
    || !("clue" in value) || typeof value.clue !== "string") {
    throw new Error("Choose a Save the Bee word and hint.");
  }
  const word = value.word.trim().toUpperCase();
  const clue = value.clue.trim();
  if (!/^[A-Z]{3,12}$/.test(word) || clue.length < 8 || clue.length > 180
    || /[\u0000-\u001f\u007f]/.test(clue) || clue.toUpperCase().includes(word)) {
    throw new Error("Use a 3-12 letter word and an 8-180 character hint that does not contain the answer.");
  }
  return { word, clue };
}
