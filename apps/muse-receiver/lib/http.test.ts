import { describe, expect, it } from "vitest";
import { InputError } from "./validation";
import { jsonRequest } from "./http";

describe("bounded JSON input", () => {
  it("accepts a valid JSON report body", async () => {
    const request = new Request("https://receiver.test/api/groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Group" }) });
    expect(await jsonRequest(request, 100)).toEqual({ name: "Group" });
  });
  it("rejects oversized, malformed and non-JSON bodies", async () => {
    const request = (body: string, type = "application/json") => new Request("https://receiver.test/api/groups", { method: "POST", headers: { "Content-Type": type }, body });
    await expect(jsonRequest(request("{"), 100)).rejects.toThrow(InputError);
    await expect(jsonRequest(request("x".repeat(200)), 100)).rejects.toThrow(InputError);
    await expect(jsonRequest(request("{}", "text/plain"), 100)).rejects.toThrow(InputError);
  });
});
