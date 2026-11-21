import { emailAvailable, EMAIL_UNAVAILABLE } from "../../../../shared/email-availability";
import type { ArtifactStore } from "../storage/artifacts";

export type EmailPreview = { subject: string; text: string; html: string };
export type EmailOutput =
  | { status: "unavailable"; reason: string }
  | { status: "available"; preview: EmailPreview };

export function unavailableEmailOutput(): EmailOutput {
  return { status: "unavailable", reason: EMAIL_UNAVAILABLE };
}

/** Recovery may read historical previews, but may not turn them into newly available output. */
export function recoveredEmailOutput(preview?: EmailPreview | null): EmailOutput {
  return emailAvailable() && preview ? { status: "available", preview } : unavailableEmailOutput();
}

export async function saveEmailOutput(store: ArtifactStore, folder: () => Promise<string>, editionId: string, output: EmailOutput): Promise<Record<string, string>> {
  if (!emailAvailable() || output.status !== "available") return {};
  const target = await folder();
  return {
    email_html: await store.saveText(target, `${editionId}.html`, output.preview.html, "text/html"),
    email_text: await store.saveText(target, `${editionId}.txt`, `Subject: ${output.preview.subject}\n\n${output.preview.text}`, "text/plain"),
  };
}
