import { ExecutionBlocked } from "../core/execution-errors";

const jobsUrl = "https://g2minhledesktopasaaervice.vercel.app/api/jobs";

async function requestJob(path: string, key: string | null | undefined, submission?: { prompt: string; id: string }) {
  if (!key?.trim()) throw new ExecutionBlocked("Add a Desktop Video API key in Environment & API settings.");
  const headers = new Headers({ Authorization: `Bearer ${key.trim()}` });
  if (submission) {
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", submission.id);
  }

  const send = () => fetch(`${jobsUrl}${path}`, {
    method: submission ? "POST" : "GET",
    headers,
    body: submission ? JSON.stringify({ prompt: submission.prompt, width: 576, height: 1024, seconds: 15 }) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const response = await (submission ? send().catch(() => send()) : send());
  if (!response.ok) throw new Error(`Desktop Video request failed (HTTP ${response.status}).`);
  return response.json();
}

export async function submitDesktopVideo(prompt: string, id: string, key: string | null | undefined) {
  const job = await requestJob("", key, { prompt, id });
  if (typeof job?.id !== "string" || !job.id || job.id.length > 128) {
    throw new Error("Desktop Video returned an invalid job ID.");
  }
  return job.id;
}

function parseDriveLink(link: string): URL | null {
  try {
    return new URL(link);
  } catch {
    return null;
  }
}

export async function checkDesktopVideo(id: string, key: string | null | undefined) {
  const job = await requestJob(`/${encodeURIComponent(id)}`, key);
  switch (job?.status) {
    case "queued":
      return { status: "queued" } as const;
    case "running":
      return { status: "processing" } as const;
    case "failed":
      return { status: "failed", error: typeof job.error === "string" ? job.error.split(key!.trim()).join("[redacted]").slice(0, 1000) : "Desktop Video generation failed." } as const;
    case "canceled":
      return { status: "failed", error: "Desktop Video canceled the job." } as const;
    case "completed": {
      const fileId = job.driveFile?.id;
      if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(fileId)) {
        return { status: "failed", error: "Desktop Video completed without a valid Google Drive file." } as const;
      }
      const fallback = `https://drive.google.com/file/d/${fileId}/view`;
      const link = typeof job.driveFile.url === "string" ? parseDriveLink(job.driveFile.url) : null;
      const safeLink = link?.origin === "https://drive.google.com" && !link.username && !link.password && (
        link.pathname === `/file/d/${fileId}/view` ||
        (link.pathname === "/open" && link.searchParams.get("id") === fileId)
      );
      return { status: "complete", url: safeLink ? link.href : fallback } as const;
    }
    default:
      throw new Error("Desktop Video returned an unknown job status.");
  }
}
