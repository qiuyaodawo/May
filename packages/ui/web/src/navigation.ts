import type { UiClientState } from "@may/ui-client";
import { button, element, icon, type WebUiContext } from "./components.js";

export interface WebUiNavigationItem {
  readonly id: string;
  readonly label: string;
  readonly title?: string;
  readonly badge?: string;
  readonly icon?: "plus" | "menu" | "send" | "stop" | "panel" | "search" | "arrow" | "code" | "task" | "trash" | "gear" | "users" | "message" | "check" | "filter";
  readonly ariaLabel?: string;
  readonly disabled?: boolean | ((state: UiClientState) => boolean);
  action(context: WebUiContext): void | Promise<void>;
}

export interface WebUiNavigationGroup {
  readonly id?: string;
  readonly title?: string;
  readonly items: readonly WebUiNavigationItem[];
}

export interface WebUiNavigationLifecycle {
  update?(state: UiClientState): void;
  dispose?(): void;
}

export interface WebUiNavigation {
  readonly groups?: readonly WebUiNavigationGroup[];
  render?(container: HTMLElement, context: WebUiContext): WebUiNavigationLifecycle | (() => void) | void;
}

export function createNavigation(
  navigation: WebUiNavigation | readonly WebUiNavigationGroup[],
  getContext: () => WebUiContext,
  onAfterAction?: () => void,
  onError?: (error: unknown) => void,
): { root: HTMLElement; update(state: UiClientState): void; dispose(): void } {
  const root = element("nav", "sidebar-navigation");
  root.setAttribute("aria-label", "服务与功能管理");

  const groups: readonly WebUiNavigationGroup[] = Array.isArray(navigation)
    ? navigation
    : (navigation as WebUiNavigation).groups ?? [];

  const itemControls: { control: HTMLButtonElement; item: WebUiNavigationItem }[] = [];

  for (const group of groups) {
    const section = element("div", "sidebar-nav-group");
    if (group.id) section.dataset.groupId = group.id;
    if (group.title) {
      const heading = element("div", "sidebar-label nav-group-title", group.title);
      section.append(heading);
    }
    const itemsContainer = element("div", "sidebar-nav-items");
    for (const item of group.items) {
      const control = button("", () => {
        try {
          const result = item.action(getContext());
          if (result && typeof (result as Promise<void>).then === "function") {
            void (result as Promise<void>).catch(error => {
              if (onError) onError(error);
              else throw error;
            });
          }
        } catch (error) {
          if (onError) onError(error);
          else throw error;
        }
        onAfterAction?.();
      }, "sidebar-nav-item");
      control.dataset.navId = item.id;
      if (item.title) control.title = item.title;
      control.setAttribute("aria-label", item.ariaLabel ?? item.title ?? item.label);
      if (item.icon) control.append(icon(item.icon));
      control.append(element("span", "nav-item-label", item.label));
      if (item.badge) control.append(element("span", "nav-item-badge", item.badge));
      itemsContainer.append(control);
      itemControls.push({ control, item });
    }
    section.append(itemsContainer);
    root.append(section);
  }

  let customLifecycle: WebUiNavigationLifecycle | undefined;
  if (!Array.isArray(navigation) && typeof (navigation as WebUiNavigation).render === "function") {
    try {
      const rendered = (navigation as WebUiNavigation).render!(root, getContext());
      if (typeof rendered === "function") {
        customLifecycle = { dispose: rendered };
      } else if (rendered && typeof rendered === "object") {
        customLifecycle = rendered;
      }
    } catch (error) {
      if (onError) onError(error);
      else throw error;
    }
  }

  let disposed = false;
  return {
    root,
    update(state: UiClientState): void {
      if (disposed) return;
      const isBlocked = state.connection !== "connected" || state.busy || state.selecting;
      for (const { control, item } of itemControls) {
        if (typeof item.disabled === "function") {
          control.disabled = item.disabled(state);
        } else if (typeof item.disabled === "boolean") {
          control.disabled = item.disabled;
        } else {
          control.disabled = isBlocked;
        }
      }
      try {
        customLifecycle?.update?.(state);
      } catch (error) {
        if (onError) onError(error);
        else throw error;
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        customLifecycle?.dispose?.();
      } catch (error) {
        if (onError) onError(error);
        else throw error;
      }
      customLifecycle = undefined;
      root.remove();
    },
  };
}
