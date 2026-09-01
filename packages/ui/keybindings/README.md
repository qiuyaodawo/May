# `@may/keybindings`

`@may/keybindings` is a UI-independent, context-aware keymap resolver. It turns
normalized key strokes and an active context stack into semantic actions. It
does not depend on May Core, MaybeCode, readline, or a renderer.

```ts
import { Keymap, keyStroke } from "@may/keybindings";

const keymap = new Keymap([
  { context: "global", keys: "<leader> l", action: "session.open" },
  { context: "select", keys: "enter", action: "list.accept" },
]);

keymap.resolve(keyStroke("enter"), ["global", "select"]);
// { type: "action", action: "list.accept" }
```

Contexts later in the stack take precedence. Multi-key sequences, configurable
leader expansion, chord timeouts, action validation, and ambiguous-binding
validation are supported. Applications own their action names and default
bindings; views own the behavior triggered by those actions.
