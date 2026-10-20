import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const email = "writer@example.iam.gserviceaccount.com";
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const credentials = { type: "service_account", client_email: email, private_key: pem };
const json = JSON.stringify(credentials);

describe("Drive service-account configuration", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "");
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", "");
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", "");
    fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "test-access-token" });
      }
      return Response.json({ files: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function list() {
    const { DriveArtifacts } = await import("../../storage/drive");
    return new DriveArtifacts().list("pipeline-folder-123");
  }

  function expectSignedToken() {
    const tokenCall = fetchMock.mock.calls.find(([url]) => url === "https://oauth2.googleapis.com/token");
    expect(tokenCall).toBeDefined();
    const body = tokenCall![1]!.body as URLSearchParams;
    const assertion = body.get("assertion")!;
    const [header, payload, signature] = assertion.split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      iss: email, scope: "https://www.googleapis.com/auth/drive", aud: "https://oauth2.googleapis.com/token",
    });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer test-access-token" });
  }

  it.each([
    ["raw JSON", json],
    ["pretty-printed JSON", JSON.stringify(credentials, null, 2)],
    ["surrounding whitespace", ` \n${json}\n `],
    ["shell single quotes", `'${json}'`],
    ["JSON-encoded string", JSON.stringify(json)],
    ["literal key newline escapes", JSON.stringify({ ...credentials, private_key: pem.replace(/\n/g, "\\n") })],
  ])("authenticates with %s", async (_name, value) => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", value);
    await expect(list()).resolves.toEqual([]);
    expectSignedToken();
  });

  it("preserves separate email/private-key configuration", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", email);
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", pem.replace(/\n/g, "\\n"));
    await expect(list()).resolves.toEqual([]);
    expectSignedToken();
  });

  it.each(["key.json", `GOOGLE_SERVICE_ACCOUNT_JSON=${json}`, "{broken", JSON.stringify("{broken")])(
    "reports malformed JSON without exposing its value",
    async (value) => {
      vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", value);
      await expect(list()).rejects.toThrow("paste the full downloaded JSON key");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([null, [], 42, {}, { client_email: email }, { ...credentials, private_key: 123 },
    { ...credentials, client_email: " " }, { ...credentials, private_key: "" }])(
    "rejects invalid credential shape %j before contacting Google",
    async (value) => {
      vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", JSON.stringify(value));
      await expect(list()).rejects.toThrow("non-empty client_email and private_key strings");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("does not silently fall back from invalid JSON to another identity", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "{broken");
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", email);
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", pem);
    await expect(list()).rejects.toThrow("GOOGLE_SERVICE_ACCOUNT_JSON must contain valid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing configuration", async () => {
    await expect(list()).rejects.toThrow("Configure GOOGLE_SERVICE_ACCOUNT_EMAIL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows retry after a configuration failure", async () => {
    const { DriveArtifacts } = await import("../../storage/drive");
    const drive = new DriveArtifacts();
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "{broken");
    await expect(drive.list("pipeline-folder-123")).rejects.toThrow("GOOGLE_SERVICE_ACCOUNT_JSON");
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    await expect(drive.list("pipeline-folder-123")).resolves.toEqual([]);
    expectSignedToken();
  });
});
