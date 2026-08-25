// A 2D canvas over the map for per-frame animation. MapLibre re-tiles a GeoJSON source on every
// change, which cannot keep up with animating thousands of points; drawing them here costs a few
// milliseconds a frame. Points are projected once per map view and cached.

import { metresPerPixel } from "./map.js";

export function overlay(map) {
  const container = map.getContainer();
  const canvas = document.createElement("canvas");
  canvas.className = "overlay";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const resize = () => {
    const scale = devicePixelRatio || 1;
    canvas.width = container.clientWidth * scale;
    canvas.height = container.clientHeight * scale;
    canvas.style.width = `${container.clientWidth}px`;
    canvas.style.height = `${container.clientHeight}px`;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
  };
  resize();
  map.on("resize", resize);

  let viewKey = null;
  const projected = new Map();
  /** Pixel positions for `points`, reused until the map moves. `id` names the set. */
  const project = (id, points) => {
    const c = map.getCenter();
    const now = `${map.getZoom()}|${c.lng}|${c.lat}|${map.getBearing()}|${map.getPitch()}`;
    if (now !== viewKey) {
      viewKey = now;
      projected.clear();
    }
    if (!projected.has(id)) projected.set(id, points.map((p) => map.project([p.lon, p.lat])));
    return projected.get(id);
  };
  return {
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },
    /** Dots for the first `to` of `points`; the set is projected once under `id`. */
    dots(id, points, color, radiusPx, alpha, to = points.length) {
      const xy = project(id, points);
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      // At a couple of pixels a square reads as a dot and costs a fraction of an arc.
      if (radiusPx <= 2.5) {
        const size = radiusPx * 2;
        for (let i = 0; i < to; i++) ctx.fillRect(xy[i].x - radiusPx, xy[i].y - radiusPx, size, size);
      } else {
        ctx.beginPath();
        for (let i = 0; i < to; i++) {
          const { x, y } = xy[i];
          ctx.moveTo(x + radiusPx, y);
          ctx.arc(x, y, radiusPx, 0, 2 * Math.PI);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
    /** Dots that have slid a fraction `t` of the way from `from` to `to` (projected under `id`). */
    slidingDots(id, from, to, t, color, radiusPx, alpha) {
      const a = project(`${id}:from`, from);
      const b = project(`${id}:to`, to);
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (let i = 0; i < a.length; i++) {
        const x = a[i].x + (b[i].x - a[i].x) * t;
        const y = a[i].y + (b[i].y - a[i].y) * t;
        ctx.moveTo(x + radiusPx, y);
        ctx.arc(x, y, radiusPx, 0, 2 * Math.PI);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    },
    /**
     * Sectors of `radiusM` metres around `centres` (projected under `id`), swept clockwise from
     * twelve o'clock through `sweep` radians like a radar; 2π is a full circle.
     */
    sectors(id, centres, color, radiusM, alpha, sweep = 2 * Math.PI) {
      const xy = project(id, centres);
      const scale = metresPerPixel(map);
      // A map too small to measure has no radius worth drawing; dividing by it would give infinity.
      const r = scale > 0 ? radiusM / scale : 0;
      const start = -Math.PI / 2;
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (const { x, y } of xy) {
        ctx.moveTo(x, y);
        ctx.arc(x, y, r, start, start + sweep);
        ctx.closePath();
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    },
    /** Polylines; each path is projected under `id` and its index. */
    lines(id, paths, color, widthPx, alpha) {
      ctx.strokeStyle = color;
      ctx.lineWidth = widthPx;
      ctx.lineCap = "round";
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      paths.forEach((path, i) => {
        const xy = project(`${id}:${i}`, path);
        xy.forEach(({ x, y }, j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    },
  };
}
