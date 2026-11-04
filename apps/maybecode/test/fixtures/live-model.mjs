import { loadMayConfig } from "@sortedyuan/may/config";
import { selectLiveModelProfile } from "@sortedyuan/test-support";

const config = await loadMayConfig();

export function liveModelProfile() {
  return selectLiveModelProfile(config);
}
