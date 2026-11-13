import type { UiClient } from "@sortedyuan/ui-client";
import { button, element } from "./components.js";
import type { WebUiOptions } from "./index.js";
import type { createUiTasks } from "./tasks.js";

export function createConnectionDialog(
  client: UiClient,
  options: Pick<WebUiOptions, "initialToken" | "connectionHint" | "authentication">,
  tasks: ReturnType<typeof createUiTasks>,
): HTMLDialogElement {
  const dialog = element("dialog", "connect-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const dialogForm = element("form");
  const dialogTitle = element("h2", "", "连接本地工作区");
  dialogTitle.id = "connection-title";
  dialog.setAttribute("aria-labelledby", dialogTitle.id);
  const explanation = element(
    "p",
    "",
    options.connectionHint ?? "输入启动服务时配置的控制令牌。令牌仅保存在当前页面内存中，刷新后需重新连接。",
  );
  const tokenLabel = element("label", "field-label", options.authentication?.label ?? "控制令牌");
  tokenLabel.htmlFor = "control-token";
  const tokenInput = element("input", "token-input");
  tokenInput.type = "password";
  tokenInput.id = "control-token";
  tokenInput.required = true;
  tokenInput.minLength = 32;
  tokenInput.maxLength = 256;
  tokenInput.autocomplete = "off";
  if (options.authentication) {
    tokenInput.minLength = 1;
    tokenInput.maxLength = 1024;
    tokenInput.autocomplete = "current-password";
  }
  const dialogError = element("p", "dialog-error");
  dialogError.setAttribute("role", "alert");
  const dialogActions = element("div", "dialog-actions");
  const connectSubmit = element("button", "button primary", "连接");
  connectSubmit.type = "submit";
  const disconnect = button("断开连接", () => {
    tasks.run(client.disconnect());
    tokenInput.value = "";
    if (options.authentication)
      tasks.run(
        options.authentication.logout().then(
          () => dialog.close(),
          (error) => {
            dialogError.textContent = error instanceof Error ? error.message : "退出失败";
          },
        ),
      );
    else dialog.close();
  });
  dialogActions.append(
    button("关闭", () => dialog.close()),
    disconnect,
  );
  dialogForm.append(dialogTitle, explanation);
  if (options.initialToken === undefined) {
    dialogForm.append(tokenLabel, tokenInput);
    dialogActions.append(connectSubmit);
  }
  dialogForm.append(dialogError, dialogActions);
  dialog.append(dialogForm);
  dialogForm.onsubmit = (event) => {
    event.preventDefault();
    if (options.initialToken !== undefined) return;
    connectSubmit.disabled = true;
    dialogError.textContent = "";
    const credential = tokenInput.value;
    tokenInput.value = "";
    const login = options.authentication
      ? options.authentication.login(credential)
      : Promise.resolve(credential.trim());
    tasks.run(
      login
        .then((token) => client.connect(token))
        .then(
          () => {
            dialog.close();
          },
          (error) => {
            dialogError.textContent = error instanceof Error ? error.message : "连接失败";
          },
        )
        .finally(() => {
          connectSubmit.disabled = false;
        }),
    );
  };
  return dialog;
}
