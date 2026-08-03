## Assistant tab overflow and scroll availability are distinct

**Learning:** Creating an assistant thread activates the newest tab and scrolls it into view, while left/right tab controls reflect the scroll viewport. Overflow alone does not establish which direction is available.

**Action:** In assistant-tab E2E, set and observe `scrollLeft` before asserting directional-control state; keep activation/scroll-into-view and arrow-availability coverage separate.

## Workflow windows must carry pending run identities

**Learning:** A workflow run that is pending at a collection boundary cannot be rediscovered from later completed-run keys alone: its creation time may fall outside the next window.

**Action:** Keep pending workflow run identities in the collector's watched set and fetch them on the next wake until completion; excluding them from completed watermark keys is not sufficient.
