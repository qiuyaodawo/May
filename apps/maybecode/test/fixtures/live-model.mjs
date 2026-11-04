import { loadMayConfig } from "@sortedyuan/may/config";
import { selectLiveModelProfile, selectLiveSwitchModelProfile } from "@sortedyuan/test-support";

const config = await loadMayConfig();

export function liveModelProfile() {
  return selectLiveModelProfile(config);
}

export function liveSwitchModelProfile() {
  return selectLiveSwitchModelProfile(config);
}
