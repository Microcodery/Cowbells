// Map marker images drawn on a canvas: start/finish dots and the course direction arrow.

const SIZE = 32;
const START = "#50a14f";
const FINISH = "#e45649";

/** Names are prefixed so they never collide with the basemap sprite's own icons. */
export const ICON_PREFIX = "cowbells-";

/** `{ name: ImageData }` for every icon the map layers reference, drawn at 2× for crisp edges. */
export function icons() {
  return {
    [`${ICON_PREFIX}start`]: dot([START]),
    [`${ICON_PREFIX}finish`]: dot([FINISH]),
    [`${ICON_PREFIX}both`]: dot([START, FINISH]),
    [`${ICON_PREFIX}arrow`]: arrow(),
  };
}

function canvas() {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  return c.getContext("2d");
}

/** A circle in one colour, or split down the middle between two. */
function dot(colors) {
  const ctx = canvas();
  const r = SIZE / 2 - 3;
  colors.forEach((color, i) => {
    ctx.beginPath();
    ctx.fillStyle = color;
    if (colors.length === 1) ctx.arc(SIZE / 2, SIZE / 2, r, 0, 2 * Math.PI);
    else ctx.arc(SIZE / 2, SIZE / 2, r, Math.PI / 2 + i * Math.PI, Math.PI / 2 + (i + 1) * Math.PI);
    ctx.fill();
  });
  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, r, 0, 2 * Math.PI);
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  return ctx.getImageData(0, 0, SIZE, SIZE);
}

/** A chevron pointing along +x, which MapLibre rotates to follow the line. */
function arrow() {
  const ctx = canvas();
  ctx.beginPath();
  ctx.moveTo(8, 6);
  ctx.lineTo(24, 16);
  ctx.lineTo(8, 26);
  ctx.lineWidth = 7;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.stroke();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  return ctx.getImageData(0, 0, SIZE, SIZE);
}
