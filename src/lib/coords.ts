// Mapping between window (CSS) coordinates and video coordinates when the
// video is letterboxed inside its element (object-fit: contain).

export interface Size {
  width: number;
  height: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Rectangle actually covered by the video inside a `container` box. */
export function letterbox(container: Box, video: Size): Box & { scale: number } {
  if (video.width <= 0 || video.height <= 0 || container.width <= 0 || container.height <= 0) {
    return { left: container.left, top: container.top, width: 0, height: 0, scale: 0 };
  }
  const scale = Math.min(container.width / video.width, container.height / video.height);
  const width = video.width * scale;
  const height = video.height * scale;
  return {
    left: container.left + (container.width - width) / 2,
    top: container.top + (container.height - height) / 2,
    width,
    height,
    scale,
  };
}

export interface VideoPoint {
  x: number;
  y: number;
  /** false when the pointer is in the black bars (the point is clamped). */
  inside: boolean;
}

/** Converts client coordinates to integer video coordinates, clamped to the frame. */
export function clientToVideo(clientX: number, clientY: number, container: Box, video: Size): VideoPoint {
  const rect = letterbox(container, video);
  if (rect.scale === 0) return { x: 0, y: 0, inside: false };
  const fx = (clientX - rect.left) / rect.scale;
  const fy = (clientY - rect.top) / rect.scale;
  const inside = fx >= 0 && fy >= 0 && fx < video.width && fy < video.height;
  const x = Math.min(Math.max(Math.floor(fx), 0), video.width - 1);
  const y = Math.min(Math.max(Math.floor(fy), 0), video.height - 1);
  return { x, y, inside };
}

/**
 * Display size to request in flex mode for a container of `css` pixels:
 * physical pixels, even, and capped (the server aligns further if needed).
 */
export function flexDisplaySize(css: Size, devicePixelRatio: number, max = 3840): Size {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  let width = Math.round(css.width * ratio);
  let height = Math.round(css.height * ratio);
  const over = Math.max(width / max, height / max, 1);
  width = Math.floor(width / over);
  height = Math.floor(height / over);
  return { width: Math.max(320, width & ~1), height: Math.max(240, height & ~1) };
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Where to put the (temporarily visible) IME text box, in container-relative
 * CSS px. The device does not report its text caret, so the last pointer
 * position stands in for it; the box is kept inside the container so the
 * IME's candidate window opens next to it. Without a pointer yet it sits at
 * the horizontal centre, in the lower third.
 */
export function imeAnchor(pointer: Point | null, container: Size, box: Size): Point {
  const wanted = pointer ?? { x: (container.width - box.width) / 2, y: container.height * 0.66 };
  const maxX = Math.max(0, container.width - box.width);
  const maxY = Math.max(0, container.height - box.height);
  return {
    x: Math.round(Math.min(Math.max(wanted.x, 0), maxX)),
    y: Math.round(Math.min(Math.max(wanted.y, 0), maxY)),
  };
}
