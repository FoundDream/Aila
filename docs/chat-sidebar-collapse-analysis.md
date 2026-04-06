# Chat Sidebar Collapse Analysis

## Goal

This change adds a collapsible chat sidebar with three requirements:

1. Clicking the toggle fully collapses the sidebar.
2. The main area becomes chat-only when the sidebar is collapsed.
3. The toggle button stays in the same visual position and only the icon changes.

## What Made This Tricky

The window uses macOS `titleBarStyle: 'hiddenInset'` and a custom drag region.
That means the top-left area near the traffic lights is not a normal content area:

- Some parts are inside Electron's draggable title bar behavior.
- Some parts must explicitly opt out with `-webkit-app-region: no-drag`.
- A button that merely looks visible there is not guaranteed to be clickable.

The early versions failed because they treated the collapsed-state toggle as a separate floating element layered over that area. Visually it looked correct, but interaction was unstable after collapse.

## Failed Approaches

### 1. Floating absolute-position toggle

The first implementation added a toggle as an absolutely positioned button in [ChatPage.tsx](/Users/Zhuanz/code/Aila/src/renderer/src/pages/chat/ChatPage.tsx).

Why it was not reliable:

- The button was visually aligned to the sidebar edge, but it lived outside the sidebar layout flow.
- When moved close to the traffic lights, it overlapped with draggable/title-bar-sensitive regions.
- After collapse, the "expand" button depended on a separate overlay path instead of the same stable DOM slot.

### 2. Separate collapsed-state overlay button

The next attempt rendered one button when expanded and another when collapsed.

Why that still broke:

- Collapse and expand used different interaction containers.
- Even with `no-drag`, the collapsed-state overlay still sat in a sensitive top-bar area.
- The structure violated the intent of "same place, icon only changes" because there were really two buttons.

## Final Solution

The final implementation uses a **single shared top bar slot** that always exists, regardless of whether the sidebar is expanded or collapsed.

### Layout structure

In [ChatPage.tsx](/Users/Zhuanz/code/Aila/src/renderer/src/pages/chat/ChatPage.tsx), the page is split into:

- A shared top bar
- A content row below it

The shared top bar itself is split into:

- A fixed-width left section aligned with the sidebar width
- A right drag region for the main content area

Inside the left section:

- A fixed spacer reserves the traffic light area
- The toggle button sits immediately after that spacer
- The remaining space stays draggable

This gives the button a permanent, predictable DOM position.

### Why this works

This approach solved the bug because:

- The toggle is always rendered in the same slot.
- Only `isSidebarCollapsed` changes, which swaps the icon and sidebar width.
- The button is always inside an explicit `[-webkit-app-region:no-drag]` container.
- The draggable areas are now surrounding the button, not overlapping it.

## State and Render Boundaries

The collapse state lives in [ChatPage.tsx](/Users/Zhuanz/code/Aila/src/renderer/src/pages/chat/ChatPage.tsx#L70) because it controls layout-level behavior:

- Sidebar width
- Sidebar visibility/interactivity
- Toggle icon state
- Main content expansion

This follows the performance rule from `AGENTS.md`:

- Put state at the smallest boundary that owns the updates.
- Keep update paths focused on layout changes instead of pushing them deeper into sidebar internals.

`SessionList` stays responsible only for sidebar content, not for window-chrome behavior.

## Sidebar Collapse Mechanics

The sidebar itself is still rendered as an `aside`, but collapse is driven by width and interaction state in [ChatPage.tsx](/Users/Zhuanz/code/Aila/src/renderer/src/pages/chat/ChatPage.tsx#L116):

- Expanded: fixed width, border visible, normal pointer events
- Collapsed: width `0`, border transparent, `pointer-events-none`, opacity reduced

This ensures the main panel naturally takes over the free space without needing a second layout mode.

## SessionList Simplification

After moving the toggle into the shared page-level top bar, [SessionList.tsx](/Users/Zhuanz/code/Aila/src/renderer/src/pages/chat/components/SessionList.tsx#L156) was simplified back to content-only responsibilities:

- New session button
- Session list
- Settings button

That made the sidebar component easier to reason about and removed the duplicated top-bar logic that was causing positioning drift.

## Key Files

- [ChatPage.tsx](/Users/Zhuanz/code/Aila/src/renderer/src/pages/chat/ChatPage.tsx): owns collapse state and shared top-bar layout
- [SessionList.tsx](/Users/Zhuanz/code/Aila/src/renderer/src/pages/chat/components/SessionList.tsx): sidebar content only
- [DragRegion.tsx](/Users/Zhuanz/code/Aila/src/renderer/src/components/DragRegion.tsx): defines draggable title-bar-safe regions
- [src/main/index.ts](/Users/Zhuanz/code/Aila/src/main/index.ts): window uses `hiddenInset` title bar and traffic light positioning, which explains the top-left interaction constraints

## Main Takeaway

The fix was not "find the perfect absolute coordinates."
The real fix was to move the toggle into a stable layout boundary and make drag/no-drag regions explicit around it.

That is why the final version behaves correctly:

- collapse works
- expand works
- the button stays in place
- only the icon changes
