import research from "../../../../Docs/image-supply-current-story-candidates.json";

/** Research leads are request drafts. They never establish photo permissions. */
export function photoSupplyOpportunities(locationId: string) {
  const community = locationId === "osm-r13915552-wa" ? "Wedgwood" : locationId === "moses-lake-wa" ? "Moses Lake" : null;
  const assets = research.assets.filter(asset => asset.community === community && asset.status !== "resolution_rejected");
  const groups = [...new Set(assets.map(asset => asset.source_url))].map((url, index) => {
    const photos = assets.filter(asset => asset.source_url === url);
    const portrait = photos[0].subject === "Donna Moodie portrait";
    return { id: `researched-${index + 1}`, name: portrait ? "Donna Moodie portrait" : new URL(url).hostname === "sdotblog.seattle.gov" ? "SDOT Route 40 photographs" : "Cascade PBS curling photographs",
      source_url: url, story_ids: [...new Set(photos.flatMap(photo => photo.story_ids))],
      contact_email: portrait ? "info@marjorierestaurant.com" : "", kind: portrait ? "person" as const : "story" as const,
      scope_name: portrait ? "Donna Moodie" : photos[0].subject, city: "Seattle", identity_url: portrait ? url : "",
      source_urls: portrait ? [] : [url],
      photos: photos.map(photo => ({ image: photo.image_url, image_source_url: photo.source_url, image_credit: photo.credit ?? "",
        image_caption: photo.subject, image_date: photo.capture_date ?? "" })) };
  });
  return { checked_on: research.checked_on, candidates: groups,
    suppliers: research.suppliers.filter(supplier => (supplier.communities as string[]).includes(community ?? "")) };
}
