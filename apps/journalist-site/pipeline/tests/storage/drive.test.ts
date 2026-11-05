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

  it("includes Shared Drive support when listing files", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", email);
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", pem);
    await list();

    const [url] = fetchMock.mock.calls.find(([input]) =>
      typeof input === "string" && input.startsWith("https://www.googleapis.com/drive/v3/files?"),
    )!;
    const params = new URL(url).searchParams;
    expect(params.get("supportsAllDrives")).toBe("true");
    expect(params.get("includeItemsFromAllDrives")).toBe("true");
  });

  it("includes Shared Drive support when creating folders and uploading files", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", email);
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", pem);
    fetchMock.mockImplementation(async (input) => {
      if (input === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "test-access-token" });
      }
      if (typeof input === "string" && input.includes("/upload/")) return Response.json({});
      if (typeof input === "string" && input.includes("fields=id")) return Response.json({ id: "created-file-id" });
      return Response.json({ files: [] });
    });
    const { DriveArtifacts } = await import("../../storage/drive");
    const drive = new DriveArtifacts();

    await drive.ensureFolder("shared-drive-root", "output-channels");
    await drive.saveText("shared-drive-root", "log.txt", "log", "text/plain");

    const driveCalls = fetchMock.mock.calls
      .map(([input]) => input)
      .filter((input) => typeof input === "string" && input.startsWith("https://www.googleapis.com/"));
    expect(driveCalls.length).toBeGreaterThanOrEqual(5);
    expect(driveCalls.every((input) => new URL(input).searchParams.get("supportsAllDrives") === "true")).toBe(true);
  });

  it("explains that a Shared Drive is required for service-account quota errors", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL", email);
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY", pem);
    fetchMock.mockImplementation(async (input) => {
      if (input === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "test-access-token" });
      }
      if (typeof input === "string" && input.includes("/upload/")) {
        return Response.json(
          { error: { message: "Service Accounts do not have storage quota." } },
          { status: 403 },
        );
      }
      if (typeof input === "string" && input.includes("fields=id")) return Response.json({ id: "created-file-id" });
      return Response.json({ files: [] });
    });
    const { DriveArtifacts } = await import("../../storage/drive");

    await expect(new DriveArtifacts().saveText("my-drive-folder", "log.txt", "log", "text/plain"))
      .rejects.toThrow("a My Drive folder shared with the account is not sufficient");
  });

  it("reports the configured identity and whether the pipeline folder is on a Shared Drive", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockImplementation(async (input) => {
      if (input === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "test-access-token" });
      return Response.json({ id: "pipeline-folder-123", name: "Pipeline", driveId: "shared-drive-123",
        capabilities: { canAddChildren: true } });
    });
    const { driveFolderDetails, driveServiceAccountEmail } = await import("../../storage/drive");
    expect(driveServiceAccountEmail()).toBe(email);
    expect(await driveFolderDetails("pipeline-folder-123")).toMatchObject({
      name: "Pipeline", driveId: "shared-drive-123", capabilities: { canAddChildren: true },
    });
    const [url] = fetchMock.mock.calls.find(([input]) =>
      typeof input === "string" && input.includes("/drive/v3/files/pipeline-folder-123?"))!;
    expect(new URL(url).searchParams.get("supportsAllDrives")).toBe("true");
  });

  it("removes test-file metadata after a quota-related upload failure", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    let listed = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (input === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "test-access-token" });
      if (typeof input === "string" && input.includes("/upload/")) return Response.json(
        { error: { message: "Service Accounts do not have storage quota." } }, { status: 403 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "POST") return Response.json({ id: "test-file-id" });
      listed++;
      return Response.json({ files: listed === 1 ? [] : [{ id: "test-file-id" }] });
    });
    const { testDriveUpload } = await import("../../storage/drive");
    const result = await testDriveUpload("pipeline-folder-123");
    expect(result).toMatchObject({ uploaded: false, cleanupError: null });
    expect(result.error).toContain("Service Accounts do not have storage quota");
    expect(fetchMock.mock.calls).toContainEqual([
      "https://www.googleapis.com/drive/v3/files/test-file-id?supportsAllDrives=true",
      expect.objectContaining({ method: "DELETE" }),
    ]);
  });

  it("removes a successful diagnostic upload too", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockImplementation(async (input, init) => {
      if (input === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "test-access-token" });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "POST") return Response.json({ id: "test-file-id" });
      if (typeof input === "string" && input.includes("/upload/")) return Response.json({ id: "test-file-id" });
      return Response.json({ files: [] });
    });
    const { testDriveUpload } = await import("../../storage/drive");
    expect(await testDriveUpload("pipeline-folder-123")).toEqual({ uploaded: true, error: null, cleanupError: null });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
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

  it("includes Shared-drive support and the parent filter on every listing page", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(Response.json({
        files: [{ id: "edition-file-123", name: "edition.json" }], nextPageToken: "next-page",
      }))
      .mockResolvedValueOnce(Response.json({ files: [{ id: "directory-file-123", name: "locations.json" }] }));
    await expect(list()).resolves.toEqual([
      { id: "edition-file-123", name: "edition.json" },
      { id: "directory-file-123", name: "locations.json" },
    ]);
    const pages = fetchMock.mock.calls.slice(1).map(([input]) => new URL(String(input)));
    for (const url of pages) {
      expect(url.searchParams.get("supportsAllDrives")).toBe("true");
      expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
      expect(url.searchParams.get("q")).toContain("'pipeline-folder-123' in parents");
    }
    expect(pages[1].searchParams.get("pageToken")).toBe("next-page");
  });

  it.each([false, true])("creates or reuses Shared-drive folders (existing: %s)", async (existing) => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(Response.json({ files: existing ? [{ id: "created-folder-123" }] : [] }))
      .mockResolvedValueOnce(Response.json({ id: "created-folder-123" }));
    const { DriveArtifacts } = await import("../../storage/drive");
    await expect(new DriveArtifacts().ensureFolder("pipeline-folder-123", "run")).resolves.toBe("created-folder-123");
    expect(fetchMock).toHaveBeenCalledTimes(existing ? 2 : 3);
    for (const [input, init] of fetchMock.mock.calls.slice(1)) {
      const url = new URL(String(input));
      expect(url.searchParams.get("supportsAllDrives")).toBe("true");
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({
          name: "run", mimeType: "application/vnd.google-apps.folder", parents: ["pipeline-folder-123"],
        });
      } else {
        expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
        expect(url.searchParams.get("q")).toContain("mimeType = 'application/vnd.google-apps.folder'");
      }
    }
  });

  it.each([false, true])("creates or updates Shared-drive JSON files (existing: %s)", async (existing) => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(Response.json({ files: existing ? [{ id: "edition-file-123" }] : [] }));
    if (!existing) fetchMock.mockResolvedValueOnce(Response.json({ id: "edition-file-123" }));
    fetchMock.mockResolvedValueOnce(Response.json({}));
    const { DriveArtifacts } = await import("../../storage/drive");
    await expect(new DriveArtifacts().saveJson("pipeline-folder-123", "edition.json", { headline: "News" }))
      .resolves.toBe("edition-file-123");
    const calls = fetchMock.mock.calls.slice(1);
    for (const [input] of calls) {
      expect(new URL(String(input)).searchParams.get("supportsAllDrives")).toBe("true");
    }
    expect(new URL(String(calls[0][0])).searchParams.get("includeItemsFromAllDrives")).toBe("true");
    if (!existing) {
      expect(JSON.parse(String(calls[1][1]?.body))).toEqual({
        name: "edition.json", mimeType: "application/json", parents: ["pipeline-folder-123"],
      });
    }
    const upload = calls.at(-1)!;
    expect(upload[1]?.method).toBe("PATCH");
    expect(upload[1]?.body).toBe(JSON.stringify({ headline: "News" }));
    expect(new URL(String(upload[0])).searchParams.get("uploadType")).toBe("media");
  });

  it("reads Shared-drive JSON and text with media access", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(Response.json({ headline: "News" }))
      .mockResolvedValueOnce(new Response("Preview"));
    const { DriveArtifacts } = await import("../../storage/drive");
    const drive = new DriveArtifacts();
    await expect(drive.readJson("edition-file-123")).resolves.toEqual({ headline: "News" });
    await expect(drive.readText("preview-file-123")).resolves.toBe("Preview");
    for (const [input] of fetchMock.mock.calls.slice(1)) {
      const url = new URL(String(input));
      expect(url.searchParams.get("supportsAllDrives")).toBe("true");
      expect(url.searchParams.get("alt")).toBe("media");
    }
  });

  it("surfaces Shared-drive permission failures", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(new Response("insufficientFilePermissions", { status: 403 }));
    await expect(list()).rejects.toThrow("Google Drive request failed (403): insufficientFilePermissions");
  });

  it("finds cleanup folders without creating them and refuses ambiguous folder names", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(Response.json({ files: [] }))
      .mockResolvedValueOnce(Response.json({ files: [{ id: "folder-one-id" }, { id: "folder-two-id" }] }));
    const { DriveArtifacts } = await import("../../storage/drive");
    const drive = new DriveArtifacts();
    expect(await drive.findFolder("pipeline-folder-123", "editions")).toBeNull();
    await expect(drive.findFolder("pipeline-folder-123", "editions")).rejects.toThrow("Ambiguous artifact folder");
    expect(fetchMock.mock.calls.slice(1).every(([, init]) => !init?.method)).toBe(true);
  });

  it("deletes only an exact regular filename under its sole verified parent, including duplicate files", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockImplementation(async (input, init) => {
      if (input === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "test-access-token" });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (String(input).includes("fields=name")) return Response.json({ name: "edition.json", mimeType: "application/json", parents: ["reader-folder-123"] });
      return Response.json({ files: [{ id: "owned-file-one", name: "edition.json" }, { id: "owned-file-two", name: "edition.json" }, { id: "shared-directory", name: "locations.json" }] });
    });
    const { DriveArtifacts } = await import("../../storage/drive");
    expect(await new DriveArtifacts().removeFile("reader-folder-123", "edition.json")).toBe(2);
    const deleted = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deleted).toHaveLength(2);
    expect(deleted.every(([url]) => String(url).includes("owned-file-") && new URL(String(url)).searchParams.get("supportsAllDrives") === "true")).toBe(true);
  });

  it.each([
    { name: "edition.json", mimeType: "application/vnd.google-apps.folder", parents: ["reader-folder-123"] },
    { name: "edition.json", mimeType: "application/json", parents: ["other-folder-123"] },
    { name: "edition.json", mimeType: "application/json", parents: ["reader-folder-123", "shared-folder-123"] },
    { name: "locations.json", mimeType: "application/json", parents: ["reader-folder-123"] },
  ])("refuses cleanup when the file has moved, is shared, renamed or is a folder: %j", async (metadata) => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(Response.json({ files: [{ id: "owned-file-one", name: "edition.json" }] }))
      .mockResolvedValueOnce(Response.json(metadata));
    const { DriveArtifacts } = await import("../../storage/drive");
    await expect(new DriveArtifacts().removeFile("reader-folder-123", "edition.json")).rejects.toThrow("Refusing cleanup");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("surfaces deletion permission errors instead of claiming files were removed", async () => {
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", json);
    fetchMock.mockResolvedValueOnce(Response.json({ access_token: "test-access-token" }))
      .mockResolvedValueOnce(Response.json({ files: [{ id: "owned-file-one", name: "edition.json" }] }))
      .mockResolvedValueOnce(Response.json({ name: "edition.json", mimeType: "application/json", parents: ["reader-folder-123"] }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const { DriveArtifacts } = await import("../../storage/drive");
    await expect(new DriveArtifacts().removeFile("reader-folder-123", "edition.json")).rejects.toThrow("artifact cleanup failed (403)");
  });
});
