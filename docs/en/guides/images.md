# Image replies

**English** | [简体中文](../../zh-CN/guides/images.md)

Messages preserve the order of `ContentPart[]`: text, image, then more text.
OpenAI Responses converts `image_generation_call.result` into a base64 image
part while retaining native continuation state. MaybeCode can also present
images from stored native OpenAI output without modifying the session journal.

## MaybeCode

Terminal frontends save embedded images under `~/.may/media/` and show the full
path, MIME type, dimensions and byte count. Open the file in an image viewer,
or use `/web` to view and download images. The readline frontend prints the
complete ordered reply after any text that was already streamed.

Both terminal frontends support Kitty, iTerm2 and Sixel graphics. Automatic
detection uses `supports-terminal-graphics` and recognizes Windows Terminal
through `WT_SESSION`. Sixel candidates are queried with DA1 to confirm support
and CSI 16 t to obtain character-cell pixel dimensions. Set
`MAY_IMAGE_PROTOCOL` to `kitty`, `iterm2`, `sixel`, `none` or `auto` to select
behavior. Explicit `sixel` skips the DA1 support requirement and still requires
cell-size reporting. Automatic mode displays attachment text inside tmux/screen
and for non-TTY output. Terminals without the required Sixel responses also
display attachment information.

Sixel previews preserve aspect ratio within 80 columns and 12 rows, with a
maximum of 1280 × 768 pixels and 256 colors. Transparent areas use a white
preview background. Encoding uses an independent pixel buffer to preserve
pixel positions and the cached source image. Saved original files retain
their transparency and quality.
Cell dimensions are queried again on resize. Retained images are redrawn at
the new size; readline uses the new size for subsequent images. Images occupy
separate rows and are drawn when fully inside the viewport. Scrolling, resizing
and dialogs remove previous retained placements. Model text cannot introduce
graphics control sequences.

To select Sixel explicitly in PowerShell before starting MaybeCode:

```powershell
$env:MAY_IMAGE_PROTOCOL = "sixel"
pnpm maybecode
```

Web UI preserves ordered content and provides original-image and download links.
Embedded image reads require authentication and ownership by the selected
session or task. Snapshots contain identifiers without base64 payloads. Browser
object URLs are released when elements are removed. HTTP(S) images are loaded
by the browser without host credentials or a referrer; their availability
depends on the source server. Terminal displays these URLs. Provider file IDs
require a host-provided `MediaReader`.

## Reusable interfaces

`@may/media` exports `DisplayPart`, `ImageAttachment`, `ImageData`, `MediaReader`,
`MediaCapabilities`, `displayParts`, `imageAttachment`, `readEmbeddedImage`,
`inspectImage`, `imagePng` and `FileMediaStore`. Its runtime dependencies are
`@may/core` and `sharp`; the Agent loop does not depend on it.

Validation supports PNG, JPEG, WebP, GIF and AVIF, with limits of 32 MiB and
40 million pixels. Unsupported formats and MIME mismatches produce errors.
Terminal and channel conversion uses a PNG frame. Hosts can supply
`ApplicationUiOptions.readMedia` or implement `UiHost.media`. The media endpoint
accepts a session/task ID and attachment ID, never an arbitrary filesystem path.
`FileMediaStore` accepts a custom directory and reader. `TerminalImages` accepts
a store, protocol and optional `{ cellSize: () => ({ width, height }) }` pixel
metrics. Sixel requires cell metrics. `NodeTerminalDriver.imageSupport` and
`createNodeTerminal().imageSupport` expose `TerminalImageSupport`; query
responses are consumed independently of keyboard input. The retained driver
starts queries automatically. Readline hosts call `query()` and await `ready()`
before printing initial images. `TerminalImages.revision` changes with image
preparation and cell metrics. Components carry graphics separately in
`RenderResult.images`; Sixel placements contain the encoded `sixel` sequence.

## Feishu and Telegram

MaybeClaw adapters declare `MediaCapabilities` and receive validated `ImageData`.
Telegram uses multipart `sendPhoto` for compatible images, and `sendDocument`
for images outside photo format/dimension limits. Feishu uploads PNG with
`image_type=message`, then sends the returned `image_key`; converted uploads
must fit 10 MiB. The app needs platform permissions for image upload and sending.

Replies with images become ordered text and image messages. Each message has
its own durable delivery record, image reference and predecessor. Confirmed
messages are not resent after restart. An uncertain send becomes `unknown`
and prevents later messages in that reply from being sent. Explicit
`/result <task-id>` creates a new delivery sequence. URLs are sent as links;
unsupported provider file IDs produce an attachment notice. Pending deliveries
require the source task session to remain available.

Additional channels implement their platform operations and capabilities while
reusing image validation, identifiers, reading and ordered content.
`ChannelHub` and `MaybeClawUiHost` accept a custom `MediaReader` for additional sources.
