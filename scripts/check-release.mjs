import { checkRelease, releaseNames } from "./release-utils.mjs";

const manifests = await checkRelease();
for (const name of releaseNames) console.log(`${name}@${manifests.get(name).manifest.version}`);
console.log(`Verified ${releaseNames.length} public packages and their runtime dependency closure`);
