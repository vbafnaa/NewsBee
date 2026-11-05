import sharp from "sharp";
import { STORY_IMAGE_MAX_BYTES, type ReaderStoryImage } from "../../../../shared/reader-stories";

const REQUEST_MAX_BYTES = STORY_IMAGE_MAX_BYTES + 64 * 1024;
export class StorySubmissionError extends Error {
  constructor(message: string, public readonly status = 422) { super(message); }
}

/** Bound the whole request, including chunked uploads, before parsing multipart or JSON. */
export async function storySubmission(request: Request): Promise<{ body: unknown; image: ReaderStoryImage | null }> {
  if (Number(request.headers.get("content-length")) > REQUEST_MAX_BYTES) {
    throw new StorySubmissionError("Submission is too large. Photos must be 2 MB or smaller.", 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new StorySubmissionError("Submission is empty", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > REQUEST_MAX_BYTES) {
        await reader.cancel();
        throw new StorySubmissionError("Submission is too large. Photos must be 2 MB or smaller.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("application/json")) {
    try { return { body: JSON.parse(new TextDecoder().decode(bytes)), image: null }; }
    catch { throw new StorySubmissionError("Request body must be valid JSON", 400); }
  }
  if (!type.startsWith("multipart/form-data")) throw new StorySubmissionError("Use JSON or a multipart form submission", 415);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { "Content-Type": type } }).formData(); }
  catch { throw new StorySubmissionError("The story form could not be read", 400); }
  const body = Object.fromEntries([...form.entries()].filter(([key]) => !["image", "consent", "image_consent"].includes(key)));
  const file = form.get("image");
  if (typeof file === "string") throw new StorySubmissionError("Choose a photo file");
  const image = file && file.size > 0 ? await prepareStoryImage(file, form) : null;
  return { body: { ...body, consent: form.get("consent") === "on" }, image };
}

async function prepareStoryImage(file: File, form: FormData): Promise<ReaderStoryImage> {
  if (file.size > STORY_IMAGE_MAX_BYTES) throw new StorySubmissionError("Photos must be 2 MB or smaller.", 413);
  const caption = String(form.get("image_caption") ?? "").trim();
  const credit = String(form.get("image_credit") ?? "").trim();
  if (!caption || caption.length > 240) throw new StorySubmissionError("Describe the photo in 1-240 characters");
  if (!credit || credit.length > 120) throw new StorySubmissionError("Give a public photo credit in 1-120 characters");
  if (form.get("image_consent") !== "on") throw new StorySubmissionError("Confirm you have permission for Newsbee to publish the photo");
  const bytes = Buffer.from(await file.arrayBuffer());
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!jpeg && !png && !webp) throw new StorySubmissionError("Choose a still JPEG, PNG or WebP photo");
  let output: Buffer;
  try {
    const image = sharp(bytes, { limitInputPixels: 25_000_000, animated: false, failOn: "warning" });
    const metadata = await image.metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) {
      throw new StorySubmissionError("Choose a still JPEG, PNG or WebP photo");
    }
    // Re-encoding removes EXIF/GPS and other original metadata; never serve uploaded bytes.
    output = await image.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } catch (error) {
    if (error instanceof StorySubmissionError) throw error;
    throw new StorySubmissionError("This photo could not be decoded. Choose a valid JPEG, PNG or WebP photo.");
  }
  if (output.length > STORY_IMAGE_MAX_BYTES) throw new StorySubmissionError("This photo is too large after processing. Choose a smaller photo.", 413);
  return { data: output.toString("base64"), mime_type: "image/jpeg", caption, credit, permission_confirmed_at: new Date().toISOString() };
}
