import type { HookContext } from "../core/index.js";
import type { PluginHost } from "../plugin/index.js";
import type { Session } from "../session/index.js";
import { applicationHooks } from "./hooks.js";

export async function completeApplicationOpening(
  session: Session,
  scope: Awaited<ReturnType<PluginHost["createScope"]>>,
  persistInitialState: (session: Session) => Promise<void>,
  connectCompactionSinks: () => void,
  hookContext: () => HookContext,
  validateToolCatalog: () => void,
  fork: boolean,
  pendingStateWrites: ReadonlySet<Promise<void>>,
): Promise<void> {
  await persistInitialState(session);
  connectCompactionSinks();
  await scope.observe(applicationHooks.created, { sessionId: session.id }, hookContext());
  validateToolCatalog();
  if (fork) {
    await Promise.all(pendingStateWrites);
    await session.saveForkReady();
  }
}
