// Pure name formatting, kept apart from the session lookup so it loads anywhere.
const ROLE_WORDS = new Set(["owner", "admin", "editor", "journalist", "operator"]);

/**
 * A readable name for greetings and the user card: the signed-in name, then the account username,
 * then the email's local part. A name that is only a role word (a demo address like owner@…) falls
 * back to the whole email, so the greeting never reads as a role.
 */
export function readableName(name: string, email: string) {
  const chosen = name.trim() || (email.split("@")[0] ?? "");
  const words = chosen.split(/[\s._-]+/).filter(Boolean);
  if (!words.length || ROLE_WORDS.has(words.join(" ").toLowerCase())) return { full: email, first: email, initials: email.slice(0, 1).toUpperCase() };
  const titled = name.trim() ? words : words.map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return { full: titled.join(" "), first: titled[0], initials: titled.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join("") };
}
