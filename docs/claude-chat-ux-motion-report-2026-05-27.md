# Claude Chat UX Motion And Interaction Report

Date: 2026-05-27

Scope: Live DOM and interaction review of Claude in Chrome, using an existing signed-in Claude chat plus a separate test chat created to observe real message lifecycle behavior. This report is written for a developer adapting the interaction model, not copying implementation details.

## Executive Summary

Claude's chat UX feels calm because the layout is stable, the motion vocabulary is small, and state changes happen in-place. The app does not rely on heavy panels or decorative animation. It uses short opacity, color, background, shadow, and transform transitions to reveal controls only when they become relevant.

The highest-value patterns to adapt are:

- A persistent sidebar with dense thread rows and quiet active state.
- A narrow centered conversation column with document-like assistant messages.
- A sticky composer whose rightmost action swaps between voice, send, and stop without moving the rest of the composer.
- Inline message actions that are present in the DOM but visually hidden until hover or focus.
- Inline branching/edit callouts instead of modals for history-changing actions.
- Tool menus and share dialogs that use restrained surfaces, small radii, and short transitions.

## Observed Desktop Layout

Viewport observed: 1680 x 857.

Primary regions:

- Sidebar: fixed left navigation, about 288px wide.
- Main header: sticky top header beginning after the sidebar.
- Conversation column: centered, about 720-768px wide.
- Composer: sticky bottom, aligned to the same conversation column.
- Toast region: fixed top-right, present but empty during observation.

Visual palette observed:

- Page background: `rgb(31, 31, 30)`.
- Composer surface: `rgb(44, 44, 42)`.
- Share dialog surface: `rgb(56, 56, 53)`.
- User message bubble: `rgb(18, 18, 18)`.
- Primary text: near white, `rgb(248, 248, 246)` and `rgb(255, 255, 255)`.
- Secondary text: warm gray, `rgb(195, 194, 183)`.
- Muted text: `rgb(151, 149, 140)`.
- Borders: low-opacity warm gray, commonly `rgba(226, 225, 218, 0.15)` to `0.3`.

The interface avoids broad color variation. The product mark and active send button provide the only warm accent moments.

## Motion System

Claude's motion system is mostly micro-motion. Most visible transitions are under 300ms and are tied to direct state changes.

Observed transition timings:

- Message action reveal: `opacity` and related properties around 150ms, cubic-bezier `(0.4, 0, 0.2, 1)`.
- Icon action buttons, including copy, retry, feedback, share, and files: `box-shadow` around 60ms.
- Artifact card buttons such as download: color/background/border/opacity/shadow/transform around 100ms.
- Scroll-to-bottom button: `opacity` around 200ms.
- Hidden composer settings and voice affordances: color/background or all-properties around 200ms.
- Composer plus button, model selector, and title controls: color/background/border/opacity/shadow/transform around 300ms, cubic-bezier near `(0.165, 0.85, 0.45, 1)`.
- Sidebar background/border/shadow transition: about 35ms, effectively immediate.
- Share dialog: opacity and transform around 200ms, cubic-bezier `(0.165, 0.84, 0.44, 1)`.

Implementation guidance:

- Keep motion short and single-purpose.
- Use opacity for reveal, color/background for affordance, and transform only for overlays or dialog entry.
- Avoid large layout-shifting animations in the conversation body.
- Keep message and composer positions stable during state changes.
- Do not animate every element. Claude leaves much of the UI static and uses motion only at decision points.

## New Chat State

The new chat screen uses a centered start state:

- Greeting: "Afternoon, Sean".
- Large centered composer.
- Placeholder: "How can I help you today?"
- Prompt chips below the composer: Write, Learn, From Drive, From Calendar, From Gmail.
- Top-right incognito control.
- No share button until a real conversation exists.
- No final thread title yet.

The composer is a rich text editor:

- DOM role: `textbox`.
- Accessible label: `Write your prompt to Claude`.
- Implementation appears ProseMirror/Tiptap-based.
- Placeholder is rendered as overlay text rather than native input placeholder.

Motion behavior:

- The new chat surface is static and quiet.
- The first meaningful motion happens when the user types: the right-side action changes from voice mode to send.

## Composer State Machine

The composer behaves like a stateful toolbar rather than a plain input.

### Empty State

Visible controls:

- Add files/connectors button on the left.
- Model selector on the right: `Opus 4.7 Adaptive`.
- Microphone/voice controls on the right.
- Voice mode as the rightmost primary action.

Behavior:

- The send button is absent.
- The composer surface remains the same size.
- Secondary settings control exists but can be visually hidden at opacity 0 until relevant.

### Draft State

Observed after typing:

- Typed text appears inside the rich text editor.
- The rightmost action changes to `Send message`.
- Send appears as a colored square icon button.
- Add and model controls do not move.
- Voice affordance is displaced by send, not placed beside it as clutter.

Implementation requirement:

- Make send eligibility a primary state change, not an added extra button.
- Reserve the rightmost control slot for exactly one primary action.

### Streaming State

Observed after sending:

- URL changes from `/new` to `/chat/{uuid}` immediately.
- Header starts as `Untitled`.
- Sidebar inserts the new chat row immediately.
- User message becomes a right-aligned bubble.
- Assistant response begins below with a compact Claude loading mark.
- Composer remains sticky and visible.
- Rightmost composer action becomes `Stop response`.
- Screen-reader status announces `Claude is responding`.

Motion behavior:

- No full-screen loading state.
- No modal.
- No page-level spinner.
- The app animates local activity only where the next response will appear.
- The composer control swap is in-place, preserving the user's spatial memory.

### Completed State

Observed after generation:

- Header title changes from `Untitled` to an auto-generated title.
- Browser title updates to match.
- Share button appears in the top-right.
- Composer returns to idle.
- Rightmost composer action returns to voice mode.
- Screen-reader status changes to `Claude finished the response`.
- Assistant message actions become available below the response.

Implementation requirement:

- Treat generated title and share affordance as progressive enrichment.
- Do not block the first response on title generation.

## Message Rendering

Claude uses asymmetric message rendering:

- User messages are right-aligned rounded bubbles.
- Assistant messages are unboxed, document-like text blocks.
- Assistant responses use markdown-like typography and spacing.
- Action rows are below messages, not inside the text.

Observed user bubble:

- Background: `rgb(18, 18, 18)`.
- Border radius: about 12px.
- Max width: about 85 percent of the message column.
- Text size: about 16px.
- Line-height: about 22.4px.

Observed assistant response:

- No card background.
- Text size: about 16px.
- Line-height: about 24px for response list items.
- Markdown list indentation uses generous left padding.
- Bold text is used for semantic emphasis inside response content.

Implementation requirement:

- Do not render every message as a symmetric bubble.
- Make assistant content readable as a document.
- Keep user messages compact and visually subordinate to assistant output.

## Message Actions

Message actions are present but low-emphasis.

User message actions:

- Timestamp.
- Retry.
- Edit.
- Copy.
- Action group has `aria-label="Message actions"`.
- Actions are opacity 0 until hover/focus, then transition to visible around 150ms.

Assistant message actions:

- Copy.
- Positive feedback.
- Negative feedback.
- Retry.
- Latest assistant response action row can be visible without hover.
- Older action rows generally reveal on hover or focus.

Observed action button style:

- 32px square icon buttons.
- Border radius around 8px.
- Transparent background by default.
- Muted icon color around `rgb(137, 135, 129)`.
- Very short `box-shadow` transition around 60ms.

Implementation requirement:

- Keep actions keyboard-focusable and accessible even when visually quiet.
- Use `opacity` reveal instead of mounting/unmounting actions on hover.
- Use accessible labels for icon-only controls.

## Edit And Branching UX

Editing a prior user message is handled inline.

Observed behavior:

- Clicking edit transforms the user bubble into an inline editor.
- The editor remains in the conversation flow.
- Buttons appear inline: Cancel and Save.
- A callout appears directly under the editor.
- Callout text explains that editing creates a new conversation branch.
- It also explains that branches can be switched using arrow navigation buttons.
- No modal appears.

Observed callout pattern:

- Small inline informational row.
- Icon plus explanatory copy.
- Placed directly next to the action's consequence.
- Does not block the rest of the page.

Implementation requirement:

- For history-changing actions, explain the consequence at the point of edit.
- Do not silently mutate prior conversation state.
- Treat edited messages as branch roots, not as destructive replacements.
- Preserve Cancel as the lowest-friction escape.

## Tool And Attachment Menu

The add/tools popover opens from the plus button inside the composer.

Observed menu surface:

- Absolute positioned menu above the composer.
- Width: about 217px.
- Height: about 326px.
- Background: `rgb(44, 44, 42)`.
- Border: `0.5px solid rgba(226, 225, 218, 0.3)`.
- Radius: about 12px.
- Padding: about 6px.
- Shadow: subtle `rgba(0, 0, 0, 0.24) 0px 2px 8px`.
- Z-index around 50.
- Menu role is present.

Observed menu items:

- Add files or photos, with shortcut `Command-U`.
- Take a screenshot.
- Add to project.
- Add from GitHub.
- Skills.
- Connectors.
- Research.
- Web search.
- Use style.

Observed item style:

- Menu item height around 32px.
- Padding around `6px 8px`.
- Radius around 8px.
- Transparent background until hover/active.
- No heavy separators except semantic grouping by vertical spacing.

Implementation requirement:

- Tool entry points should stay in the composer, not in a distant global toolbar.
- Put common file and connector actions in one compact menu.
- Use short labels and reserve descriptions for deeper configuration screens.
- Include keyboard shortcuts where the action is frequent.

## Model Selector

The model selector is embedded in the composer and stays visible through idle, draft, and completed states.

Observed behavior:

- Accessible label: `Model: Opus 4.7 Adaptive`.
- Small inline button, about 158px wide and 32px tall.
- Font size around 12-14px.
- The model name and mode are displayed together.
- It uses a 300ms color/background/opacity/shadow/transform transition.

Implementation requirement:

- Keep model selection visible but low-emphasis.
- Do not make model controls compete with send/stop.
- Keep the current model text compact enough to fit in the composer.

## Share Dialog

The share control appears only once the chat exists.

Observed dialog:

- Centered fixed modal.
- Width: about 520px.
- Height: about 331px.
- Background: `rgb(56, 56, 53)`.
- Radius: about 12px.
- Shadow combines inset outline, small elevation, and larger panel shadow.
- Transition: opacity and transform around 200ms.
- Header: `Share chat`.
- Secondary copy: `Only messages up to this point will be shared.`

Observed options:

- Keep private - Only you have access.
- Create public link - Anyone with the link can view.
- Privacy warning: do not share personal information or third-party content without permission.
- Link to usage policy.
- Primary action: Create share link.

Implementation requirement:

- For sharing, use a modal because it changes access and privacy.
- Make the privacy state explicit.
- Say exactly what part of the chat will be shared.
- Keep the dialog small and direct.

## Artifact And File Card Behavior

The inspected original chat included a generated document card.

Observed card behavior:

- Card is a bordered compact row inside the assistant response.
- The entire card has an invisible full-card button: `View Pr iteration protocol`.
- Actions appear on the right: provider/export icon and `Download`.
- Download button is bordered, about 36px tall, 8px radius.
- Artifact action transitions are around 100ms.

Implementation requirement:

- Artifacts should be first-class message attachments, not separate pages.
- Make the whole artifact row clickable to view.
- Keep secondary actions like download on the right edge.
- Avoid turning artifacts into large decorative cards.

## Sidebar And Thread UX

Observed sidebar behavior:

- Fixed left rail, about 288px wide.
- Primary navigation at top.
- Product section below.
- Recents list below product section.
- Account/settings area pinned at bottom.
- Sidebar scroll is independent of the conversation.

Primary nav items:

- New chat.
- Search.
- Chats.
- Projects.
- Artifacts.
- Customize.

Thread row behavior:

- Rows are dense, around 32px tall.
- Active row uses a subtle darker background.
- Thread titles are single-line truncated.
- Long labels use mask/gradient behavior on hover/focus instead of wrapping.
- Current row exposes a more-options affordance.
- More-options labels include the thread title for accessibility.

Implementation requirement:

- Keep thread discovery dense.
- Never wrap thread titles in the sidebar.
- Preserve independent sidebar and conversation scrolling.
- Use keyboard shortcut hints for New chat and Search.

## Loading, Status, And Callouts

Claude uses several layers of feedback:

- Visual loading mark near the assistant response.
- Composer stop button during active generation.
- Screen-reader status messages for responding and finished states.
- Inline branch warning during edit.
- Inline privacy warning in share dialog.
- Inline disclaimer under composer: `Claude is AI and can make mistakes. Please double-check responses.`

What it avoids:

- Surprise modals during ordinary generation.
- Toast spam for normal chat events.
- Full-screen loading.
- Layout shifts when the response starts or ends.

Implementation requirement:

- Map feedback to the user's current locus of attention.
- Use modals only for access/privacy decisions.
- Use inline callouts for local consequences.
- Keep global toasts for exceptional background events only.

## Accessibility Requirements

Observed accessibility details:

- Composer has `role="textbox"` and a clear label.
- Loading state has screen-reader status text.
- Message groups include hidden headings like `You said:` and `Claude responded:`.
- Message actions use `role="group"` and `aria-label="Message actions"`.
- Icon-only buttons have accessible labels.
- Title button accessible label includes rename intent.
- Current row overflow labels include the thread title.

Implementation requirement:

- Do not rely on visible labels for icon buttons.
- Use hidden headings to preserve conversation structure for screen readers.
- Use status regions for streaming state.
- Keep hover-only controls focus-revealed as well.

## Suggested Component Model

Build the experience from these primitives:

- `ConversationShell`: owns route, title state, header actions, share visibility, and responsive layout.
- `ThreadSidebar`: owns fixed navigation, recents, active row state, row overflow, and independent scrolling.
- `MessageList`: owns turn ordering, auto-scroll policy, content visibility/windowing if needed, and scroll-to-bottom affordance.
- `UserTurn`: renders right-aligned bubble, timestamp, retry, edit, copy, and branch edit mode.
- `AssistantTurn`: renders markdown body, status/progress, feedback, copy, retry, and artifacts.
- `ArtifactCard`: renders inline file/document outputs with view and download actions.
- `Composer`: owns rich text input and state transitions between empty, draft, streaming, and idle.
- `ToolMenu`: owns attachments, connectors, project, research, and style actions.
- `ShareDialog`: owns privacy/access state and public link creation.
- `Callout`: reusable inline explanation for branching, privacy, errors, or destructive consequences.

## Motion Tokens To Start With

Use a small token set:

```ts
export const motion = {
  instant: "35ms",
  press: "60ms",
  smallControl: "100ms",
  reveal: "150ms",
  overlay: "200ms",
  surface: "300ms",
  standardEase: "cubic-bezier(0.4, 0, 0.2, 1)",
  softEase: "cubic-bezier(0.165, 0.84, 0.44, 1)",
  softOut: "cubic-bezier(0.165, 0.85, 0.45, 1)",
};
```

Recommended mapping:

- `press`: icon button focus/press/shadow feedback.
- `smallControl`: artifact buttons and small bordered controls.
- `reveal`: message action opacity and text color hover.
- `overlay`: share dialog, popover fade/scale if implemented.
- `surface`: composer controls, title controls, plus/model affordances.

## Implementation Checklist

- Keep the conversation column narrow on desktop.
- Render assistant output as document text, not a bubble.
- Render user messages as compact right-aligned bubbles.
- Keep the composer sticky and stable.
- Swap the composer primary action in-place: voice, send, stop.
- Show tool entry through the composer plus button.
- Make message actions hover/focus-revealed, not permanently loud.
- Use inline callouts for branch, retry, and consequence states.
- Generate chat title after the first response without blocking the conversation.
- Insert new chats into recents optimistically.
- Keep share hidden until the conversation has a persisted chat route.
- Use modal treatment only for privacy/access sharing.
- Add screen-reader status for responding and completed generation.
- Preserve keyboard and accessible labels for icon-only controls.

## Anti-Patterns To Avoid

- Adding a large top toolbar for tools.
- Making every assistant response a card.
- Showing all message actions all the time.
- Moving the composer when send/stop state changes.
- Using toasts for normal streaming progress.
- Editing prior messages silently in place without branch semantics.
- Hiding privacy consequences behind a single "Share" button.
- Letting sidebar thread titles wrap.
- Introducing long, decorative animations into the conversation flow.

## Source Notes

Evidence came from live DOM inspection, computed styles, screenshots, and direct interaction with Claude in Chrome. A separate test chat was created to observe: new chat, draft, send, streaming, completion, follow-up, and inline edit/branch callout behavior. The original user-provided chat tab was restored after inspection.
