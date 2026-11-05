"use client";

import UsageMap from "../usage-map";
import { loadSampleUsage } from "./sample-data";

export default function SampleMap() {
  return <UsageMap preview loadUsage={loadSampleUsage} />;
}
