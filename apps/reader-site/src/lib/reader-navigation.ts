import { TOPICS } from "../../../../shared/topics";

/** Match the front-page sections; each remaining topic has a card in Other news. */
export function sectionNavigation(visible: readonly string[], fullLabels = false) {
  const primary = [
    { id: "top-news", label: "Top News" },
    { id: "events", label: "Events" },
    { id: "housing", label: fullLabels ? "Housing & Development" : "Housing" },
    { id: "policy", label: fullLabels ? "Policy Updates" : "Policy" },
  ].filter((section) => visible.includes(section.id));
  if (TOPICS.some((topic) => topic.id !== "housing" && topic.id !== "policy" && visible.includes(topic.id))) {
    primary.push({ id: "other-news", label: "Other News" });
  }
  return primary;
}
