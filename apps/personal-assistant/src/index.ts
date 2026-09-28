export { runCli, type CliOutput, type RunCliDependencies } from "./cli.js";
export { CLI_USAGE, parseCliArgs, type CliCommand, type ParsedCommand } from "./args.js";
export { PersonalAssistant, type PersonalAssistantOptions, type ServeResult } from "./service.js";
export {
  createAssistantContext,
  closeAssistantContext,
  type AssistantContext,
} from "./context.js";
export { openAssistantApplication, createAssistantTools } from "./agent.js";
export { assistantSettings, SettingsError, type AssistantSettings } from "./settings.js";
export { BASE_INSTRUCTIONS } from "./instructions.js";
export { createPermissionPolicy } from "./permissions.js";
export { Vault, type VaultEntry, type VaultSearchHit, type VaultStatus } from "./vault/vault.js";
export { RuleBook, learnSkill, type RuleRecord } from "./growth/rule-book.js";
export { Mailbox, type DraftView } from "./mail/mailbox.js";
export { MailLedger, type MailCheckResult } from "./mail/ledger.js";
export { draftDigest, shortDigest, type DraftContent, type MailDraftRecord } from "./mail/types.js";
export { EhallService } from "./ehall/service.js";
export { EhallCatalogError, loadCatalog, parseCatalog, type EhallService as EhallServiceEntry } from "./ehall/catalog.js";
export { formDigest, prepareTransaction, shortDigest as shortFormDigest } from "./ehall/plan.js";
export { startAssistantServer, createControlToken, type AssistantServer } from "./server/http.js";
export { assistantWebAssets } from "./server/web.js";
export { createProductUi, PRODUCT_COMMANDS } from "./server/ui.js";
