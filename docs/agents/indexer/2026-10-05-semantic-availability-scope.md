# Semantic availability scope — 2026-10-05

The final M2 lint ratchet found synchronous state resets inside the native search
controller effect. The rendered availability belonged to the previous scope
until that effect ran. A new assertion in the existing capability-change and
owned-inference test recorded `true` once after the capability became null (RED).

Availability results now retain their exact request scope; rendering derives a
pending refusal whenever that scope differs. The effect only observes the async
native check and discards retired results. Original inference cancellation and
physical promise settlement assertions remain in the same test. Public native
provider/hook exports remain stable after separating their React Refresh module
boundaries; the context remains one shared instance.

This follows React's documented render-time derivation approach:
https://react.dev/learn/you-might-not-need-an-effect
No warning baseline increase, asynchronous scheduling workaround, or native
writer/runtime change was introduced.
