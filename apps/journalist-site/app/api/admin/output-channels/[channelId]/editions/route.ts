import { adminRoute, jsonBody } from "@/lib/admin-api";
import {
  createOutputChannelEdition,
  getOutputChannel,
  listOutputChannelEditions,
  outputChannels,
  type ChannelEditionStory,
  type ChannelReaderEdition,
} from "@/pipeline/orchestration/output-channels";
import { COLLECTIONS } from "@/pipeline/storage/mongo";
import { videoStoriesForLocation } from "@/pipeline/video-production";

type Context = { params: Promise<{ channelId: string }> };
type StorySelection = { locationId: string; storyId: string };
type OutputMode = "reader" | "video";
type PublishedItem = Record<string, unknown> & { story_id?: string; headline?: string };
type PublishedSource = {
  id: string;
  location_id: string;
  location_name: string;
  window_start?: string;
  window_end?: string;
  published?: { items?: PublishedItem[] };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStorySelection(value: unknown): value is StorySelection {
  return isRecord(value) &&
    typeof value.locationId === "string" && value.locationId.length > 0 && value.locationId.length <= 256 &&
    typeof value.storyId === "string" && value.storyId.length > 0 && value.storyId.length <= 256;
}

function isOutputMode(value: unknown): value is OutputMode {
  return value === "reader" || value === "video";
}

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: Context) {
  const { channelId } = await context.params;
  return adminRoute(request, async ({ db, principal }) => {
    if (!principal) throw new Error("Sign in as an approved journalist.");
    const channel = await getOutputChannel(db, principal.id, channelId);
    if (!channel) return Response.json({ detail: "Publishing channel was not found." }, { status: 404 });
    const storyGroups: Awaited<ReturnType<typeof videoStoriesForLocation>>[] = [];
    for (let offset = 0; offset < channel.selectedLocationIds.length; offset += 10) {
      storyGroups.push(...await Promise.all(
        channel.selectedLocationIds.slice(offset, offset + 10).map((locationId) => videoStoriesForLocation(db, locationId)),
      ));
    }
    const stories = storyGroups.flatMap(({ location, stories: locationStories }) => locationStories.map((story) => ({
      ...story,
      locationId: location.id,
      locationName: location.name,
    })));
    const editions = await listOutputChannelEditions(db, principal.id, channelId);
    return {
      stories,
      editions: editions.map(({ _id, title, created_at, output_modes, stories: selected, video_stories }) => ({
        id: _id,
        title,
        createdAt: created_at,
        outputModes: output_modes,
        storyCount: selected.length,
        videoStories: video_stories.map((story) => ({
          ...story,
          title: selected.find((item) => item.location_id === story.location_id && item.story_id === story.story_id)?.headline ?? story.story_id,
        })),
      })),
      availableOutputs: channel.destinations.map((destination) => destination.type),
      enabled: channel.enabled,
    };
  });
}

export async function POST(request: Request, context: Context) {
  const { channelId } = await context.params;
  return adminRoute(request, async (deps) => {
    if (!deps.principal) throw new Error("Sign in as an approved journalist.");
    const body = await jsonBody<unknown>(request);
    if (!isRecord(body)) {
      return Response.json({ detail: "Enter an edition title and select between 1 and 30 published stories." }, { status: 422 });
    }
    const titleValue = body.title;
    const rawSelections = body.stories;
    const rawOutputs = body.outputModes;
    const rawVideoStories = body.videoStories;
    if (typeof titleValue !== "string" || !titleValue.trim() || titleValue.trim().length > 120 ||
      !Array.isArray(rawSelections) || rawSelections.length < 1 || rawSelections.length > 30 ||
      !rawSelections.every(isStorySelection) ||
      !Array.isArray(rawOutputs) || rawOutputs.length < 1 || rawOutputs.length > 2 ||
      !rawOutputs.every(isOutputMode) || new Set(rawOutputs).size !== rawOutputs.length ||
      !Array.isArray(rawVideoStories) || rawVideoStories.length > 30 ||
      !rawVideoStories.every(isStorySelection)) {
      return Response.json({ detail: "Enter an edition title, select stories and at least one output mode." }, { status: 422 });
    }
    const title = titleValue.trim();
    const selections = rawSelections;

    const owner = deps.principal.id;
    const channel = await outputChannels(deps.db).findOne({ _id: channelId, owner_id: owner });
    if (!channel) return Response.json({ detail: "Publishing channel was not found." }, { status: 404 });
    const destinations = channel.destinations?.length
      ? channel.destinations
      : [{ type: channel.destination ?? "reader", url: channel.url ?? "" }];
    if (!channel.enabled) return Response.json({ detail: "Enable this channel before creating an edition." }, { status: 409 });
    const availableOutputs = new Set(destinations.map((destination) => destination.type));
    if (rawOutputs.some((mode) => !availableOutputs.has(mode))) {
      return Response.json({ detail: "Choose only output modes enabled for this channel." }, { status: 422 });
    }
    const unique = new Set(selections.map(({ locationId, storyId }) => `${locationId}:${storyId}`));
    if (unique.size !== selections.length) {
      return Response.json({ detail: "A story can only be selected once." }, { status: 422 });
    }
    if (selections.some(({ locationId }) => !channel.selected_location_ids.includes(locationId))) {
      return Response.json({ detail: "Select stories only from communities assigned to this channel." }, { status: 422 });
    }
    const selectedKeys = new Set(selections.map(({ locationId, storyId }) => `${locationId}:${storyId}`));
    const videoKeys = new Set(rawVideoStories.map(({ locationId, storyId }) => `${locationId}:${storyId}`));
    if (videoKeys.size !== rawVideoStories.length ||
      rawVideoStories.some(({ locationId, storyId }) => !selectedKeys.has(`${locationId}:${storyId}`))) {
      return Response.json({ detail: "Choose video stories from the stories included in this edition, without duplicates." }, { status: 422 });
    }
    if (videoKeys.size > 0 && !rawOutputs.includes("video")) {
      return Response.json({ detail: "Select video output to include stories for video generation." }, { status: 422 });
    }
    if (rawOutputs.includes("video") && videoKeys.size === 0) {
      return Response.json({ detail: "Select at least one story for video generation." }, { status: 422 });
    }
    if (rawOutputs.includes("reader") && !availableOutputs.has("reader")) {
      return Response.json({ detail: "This channel does not have a Reader destination." }, { status: 422 });
    }

    const sources = await Promise.all(selections.map(async ({ locationId, storyId }) => {
      const source = await deps.db.collection<PublishedSource>(COLLECTIONS.editions).findOne({
        location_id: locationId,
        status: "published",
        "published.items.story_id": storyId,
      }, { sort: { published_at: -1 } });
      const item = source?.published?.items?.find((candidate) => candidate.story_id === storyId && candidate.headline);
      if (!source || !item) throw new Error(`Unknown source story: ${storyId}`);
      return { locationId, storyId, source, item };
    }));
    const storyDetails: ChannelEditionStory[] = sources.map(({ locationId, storyId, source, item }) => ({
      location_id: locationId,
      location_name: source.location_name,
      edition_id: source.id,
      story_id: storyId,
      headline: String(item.headline),
      blurb: typeof item.blurb === "string" ? item.blurb : "",
      event_date: typeof item.event_date === "string" ? item.event_date : "",
      source_url: typeof item.source_url === "string" ? item.source_url : null,
    }));
    const now = Date.now() / 1000;
    const grouped = new Map<string, { source: PublishedSource; items: PublishedItem[] }>();
    for (const [index, resolved] of sources.entries()) {
      const group = grouped.get(resolved.locationId) ?? { source: resolved.source, items: [] };
      group.items.push({ ...resolved.item, rank: index + 1 });
      grouped.set(resolved.locationId, group);
    }
    const today = new Date(now * 1000).toISOString().slice(0, 10);
    const readerEditions: ChannelReaderEdition[] = rawOutputs.includes("reader") ? [...grouped.values()].map(({ source, items }, index) => ({
      id: `${channelId}-${index + 1}`,
      location_id: source.location_id,
      location_name: source.location_name,
      window_start: source.window_start ?? today,
      window_end: source.window_end ?? today,
      published_at: now,
      headline: title,
      intro: `A curated edition prepared for ${channel.name}.`,
      items,
      coverage: [],
      corrections: [],
    })) : [];
    const edition = await createOutputChannelEdition(
      deps.db,
      deps.store,
      channel,
      owner,
      title,
      storyDetails,
      rawOutputs,
      rawVideoStories.map(({ locationId, storyId }) => ({ location_id: locationId, story_id: storyId })),
      readerEditions,
    );
    return Response.json({
      edition: {
        id: edition._id,
        title: edition.title,
        createdAt: edition.created_at,
        storyCount: edition.stories.length,
        outputModes: edition.output_modes,
        videoStories: rawVideoStories.map(({ locationId, storyId }) => ({
          locationId,
          storyId,
          title: storyDetails.find((story) => story.location_id === locationId && story.story_id === storyId)?.headline ?? storyId,
        })),
      },
    }, { status: 201 });
  });
}
