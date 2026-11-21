import { expect, it } from "vitest";
import { readableName } from "../../../lib/readable-name";

it.each([
  ["Maya Singh", "maya@example.test", { full: "Maya Singh", first: "Maya", initials: "MS" }],
  ["", "maya.singh@example.test", { full: "Maya Singh", first: "Maya", initials: "MS" }],
  ["", "editor-a@newsbee.local", { full: "Editor A", first: "Editor", initials: "EA" }],
  // A demo address that is only a role word never greets someone as their role.
  ["", "owner@newsbee.local", { full: "owner@newsbee.local", first: "owner@newsbee.local", initials: "O" }],
  ["", "admin@newsbee.local", { full: "admin@newsbee.local", first: "admin@newsbee.local", initials: "A" }],
])("greets %s / %s by name, not role", (name, email, expected) => {
  expect(readableName(name, email)).toEqual(expected);
});
