import { selectLiveModelProfile } from "@sortedyuan/test-support";

import { loadMayConfig } from "@sortedyuan/may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@sortedyuan/providers";

export const documentPath = new URL("../../../../../README.md", import.meta.url);

export async function createModel() {
  const config = await loadMayConfig();
  return createBuiltinProviderModel(selectProviderModel(config, { model: selectLiveModelProfile(config) }));
}
