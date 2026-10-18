/**
 * A webdriver spec that reloads and reads persisted state opts into strict
 * durable writes before the app boots. The default relaxed PGlite store
 * fire-and-forgets `syncToFs`, so a reload right after a write can lose it.
 */
export function webE2ERequiresDurableWrites(): boolean {
  return (
    window.navigator.webdriver === true &&
    Reflect.get(window, '__brainstrikeWebE2ERequireDurableWrites__') === true
  );
}
