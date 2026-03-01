/**
 * Chromium GPU command-line switch configuration for the Electron main process.
 *
 * These flags are critical to preventing the SIGTRAP crash that occurs when
 * GPU rasterization contends with ONNX Runtime's WebGPU (Dawn) inference on
 * the Metal command queue. See: docs/debug-handoff-renderer-crash.md
 */

/**
 * Chromium features to disable via `--disable-features`.
 *
 * - MacWebContentsOcclusion: macOS deprioritizes the GPU context when the window
 *   is occluded (behind another window). This starves WebGPU command submissions
 *   after ~4 minutes of background operation.
 * - SpareRendererForSitePerProcess: a spare renderer process that competes for
 *   GPU/Metal command queue resources with the primary renderer's ONNX Runtime
 *   WebGPU backend.
 */
export const DISABLED_CHROMIUM_FEATURES = [
  'MacWebContentsOcclusion',
  'SpareRendererForSitePerProcess',
] as const satisfies readonly string[];

/**
 * GPU command-line switches that must NEVER be re-added.
 *
 * These push rasterization onto the same GPU command queue that ONNX/Dawn uses
 * for WebGPU inference. Under sustained background embedding load, the Metal
 * command queue race causes a Dawn CHECK() → SIGTRAP at ~4 minutes.
 *
 * If a future performance optimization tempts re-enabling these, it MUST be
 * validated with a 10+ minute background idle test with active embedding load.
 */
export const FORBIDDEN_GPU_SWITCHES = [
  'enable-gpu-rasterization',
  'enable-zero-copy',
] as const satisfies readonly string[];
