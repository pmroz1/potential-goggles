/**
 * Low-overhead pointer drag helper.
 *
 * - Listeners are attached with `addEventListener` (not template bindings), so
 *   pointer moves never trigger Angular change detection.
 * - Moves are coalesced to at most one `onFrame` call per animation frame.
 * - The pointer is captured so the drag continues outside the element.
 *
 * Callers update the DOM directly in `onFrame` (e.g. a CSS `translate`) and
 * commit a single edit in `onEnd`.
 */
export interface PointerDragHandlers {
  onFrame(clientX: number, clientY: number): void;
  onEnd(clientX: number, clientY: number, cancelled: boolean): void;
}

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const animationFrameScheduler: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export function startPointerDrag(
  event: PointerEvent,
  element: HTMLElement,
  handlers: PointerDragHandlers,
  scheduler: FrameScheduler = animationFrameScheduler,
): () => void {
  const pointerId = event.pointerId;
  let lastX = event.clientX;
  let lastY = event.clientY;
  let frame: number | null = null;
  let finished = false;

  const flush = () => {
    frame = null;
    handlers.onFrame(lastX, lastY);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) {
      return;
    }
    lastX = e.clientX;
    lastY = e.clientY;
    if (frame === null) {
      frame = scheduler.request(flush);
    }
  };

  const finish = (cancelled: boolean, e?: PointerEvent) => {
    if (finished || (e && e.pointerId !== pointerId)) {
      return;
    }
    finished = true;
    if (e && !cancelled) {
      lastX = e.clientX;
      lastY = e.clientY;
    }
    if (frame !== null) {
      scheduler.cancel(frame);
      frame = null;
    }
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onUp);
    element.removeEventListener('pointercancel', onCancel);
    element.removeEventListener('lostpointercapture', onCancel);
    if (element.hasPointerCapture?.(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
    handlers.onEnd(lastX, lastY, cancelled);
  };
  const onUp = (e: PointerEvent) => finish(false, e);
  const onCancel = (e: PointerEvent) => finish(true, e);

  element.setPointerCapture?.(pointerId);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onCancel);
  element.addEventListener('lostpointercapture', onCancel);

  return () => finish(true);
}
