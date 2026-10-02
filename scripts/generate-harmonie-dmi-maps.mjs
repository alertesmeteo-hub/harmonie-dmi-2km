#!/usr/bin/env node
// Produit des cartes PNG (temperature, pluie, vent, nuages...) a partir des
// points deja recuperes par update-harmonie-dmi.mjs, pour le departement 66
// uniquement. Aucun appel reseau ici : on post-traite build/national/
// departements/66.json, donc zero risque supplementaire de rate-limit DMI.
//
// Usage :
//   node scripts/generate-harmonie-dmi-maps.mjs --output-dir build/national

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const WIDTH = 360;
const HEIGHT = 300;
const BUFFER_DEG = 0.06;
const NEIGHBOURS = 8;
// Couches a paliers nets (pluie) : rendues 3x plus fines, sinon les marches de
// couleur apparaissent en escalier des qu'on zoome sur la carte.
const DISCRETE_SCALE = 3;

const TEMP_STOPS = [
  [-25, "#7209b7"], [-15, "#3a0ca3"], [-5, "#4361ee"], [0, "#4cc9f0"], [5, "#2ec4b6"],
  [10, "#52b788"], [15, "#a7d129"], [20, "#ffea00"], [25, "#ffb700"], [30, "#ff7b00"],
  [35, "#ff3d00"], [40, "#e01e37"], [45, "#9d0208"],
];
const PRECIP_STOPS = [
  [0.1, "#f5f5f7"], [1, "#c9e6ff"], [2, "#7fbbff"], [3, "#438fff"], [5, "#1bd0ef"],
  [7, "#00b8bd"], [10, "#00ca76"], [15, "#32e300"], [20, "#86ed00"], [25, "#d2ef00"],
  [30, "#fff000"], [40, "#ffd000"], [50, "#ff9900"], [60, "#ff6500"], [70, "#ff2e00"],
  [80, "#ef0054"], [90, "#d000a7"], [100, "#a000e8"], [125, "#6900dc"], [150, "#4b00b4"],
  [175, "#291078"], [200, "#661070"], [250, "#a548bd"], [300, "#d487e1"], [400, "#f0c8f2"],
  [500, "#ffffff"],
];
const WIND_STOPS = [
  [0, "#caf0b8"], [10, "#7bdc6e"], [20, "#2fbf5f"], [30, "#00a99d"], [40, "#0080c9"],
  [50, "#3d5afe"], [60, "#8e24aa"], [80, "#e0218a"], [100, "#ff0044"],
];
const GUST_STOPS = [
  [0, "#caf0b8"], [20, "#7bdc6e"], [40, "#ffea00"], [60, "#ff9100"], [80, "#ff0044"],
  [100, "#c2007a"], [130, "#6a0dad"], [160, "#1a0a2e"],
];
const CLOUD_STOPS = [
  [0, "#e6f4fa"], [20, "#cddfe7"], [40, "#adbec8"], [60, "#8997a4"], [80, "#626e79"], [100, "#343d46"],
];
const HUMIDITY_STOPS = [
  [0, "#9a5429"], [20, "#d19a52"], [40, "#e3d16b"], [60, "#83ca82"], [80, "#48a6b6"], [100, "#28569f"],
];
const VISIBILITY_STOPS = [
  [0, "#7b1f1f"], [1, "#cf3d35"], [2, "#ed8b33"], [5, "#e6ce4f"], [10, "#88c681"], [20, "#67b8d0"], [50, "#d8f1ff"],
];

// key = nom de fichier attendu par /carte-modele (OFFICIAL_LAYERS), column =
// colonne de departements/66.json, cumulative = somme depuis le debut du run.
const LAYERS = [
  { key: "temperature", column: "temperature_c", stops: TEMP_STOPS },
  { key: "point_rosee", column: "dewpoint_c", stops: TEMP_STOPS },
  { key: "pluie_1h", column: "precipitation_mm", stops: PRECIP_STOPS, discrete: true, transparentBelow: 0.03, opacity: 255 },
  { key: "pluie_cumul", column: "precipitation_mm", stops: PRECIP_STOPS, discrete: true, transparentBelow: 0.03, opacity: 255, cumulative: true },
  { key: "vent", column: "wind_speed_kmh", stops: WIND_STOPS },
  { key: "rafales", column: "wind_gust_kmh", stops: GUST_STOPS },
  { key: "nuages_bas", column: "cloud_low_pct", stops: CLOUD_STOPS },
  { key: "nuages_moyens", column: "cloud_mid_pct", stops: CLOUD_STOPS },
  { key: "nuages_eleves", column: "cloud_high_pct", stops: CLOUD_STOPS },
  { key: "humidite", column: "humidity_pct", stops: HUMIDITY_STOPS },
  { key: "visibilite", column: "visibility_km", stops: VISIBILITY_STOPS },
];

function parseArgs(argv) {
  const args = { outputDir: "build/national" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output-dir") args.outputDir = argv[++i];
    else throw new Error(`Argument inconnu : ${a}`);
  }
  return args;
}

function hexToRgb(hex) {
  const n = hex.replace("#", "");
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function colorForValue(value, stops, discrete) {
  if (value <= stops[0][0]) return hexToRgb(stops[0][1]);
  if (value >= stops[stops.length - 1][0]) return hexToRgb(stops[stops.length - 1][1]);
  for (let i = 0; i < stops.length - 1; i++) {
    const [v0, c0] = stops[i];
    const [v1, c1] = stops[i + 1];
    if (value >= v0 && value <= v1) {
      if (discrete) return hexToRgb(c0);
      const f = v1 === v0 ? 0 : (value - v0) / (v1 - v0);
      const rgb0 = hexToRgb(c0);
      const rgb1 = hexToRgb(c1);
      return [0, 1, 2].map((k) => Math.round(rgb0[k] + (rgb1[k] - rgb0[k]) * f));
    }
  }
  return hexToRgb(stops[stops.length - 1][1]);
}

// Pour chaque pixel : indices et poids IDW des NEIGHBOURS points les plus
// proches, calcules une seule fois puis reutilises pour chaque couche/echeance.
function buildInterpolation(bounds, points, lonScale, W, H) {
  const n = W * H;
  const k = Math.min(NEIGHBOURS, points.length);
  const indexes = new Int16Array(n * k);
  const weights = new Float32Array(n * k);
  const dist = new Float64Array(points.length);
  const order = new Array(points.length);
  for (let y = 0; y < H; y++) {
    const lat = bounds.north - (y / (H - 1)) * (bounds.north - bounds.south);
    for (let x = 0; x < W; x++) {
      const lon = bounds.west + (x / (W - 1)) * (bounds.east - bounds.west);
      for (let i = 0; i < points.length; i++) {
        order[i] = i;
        dist[i] = Math.hypot((lon - points[i][0]) * lonScale, lat - points[i][1]);
      }
      order.sort((a, b) => dist[a] - dist[b]);
      const o = (y * W + x) * k;
      for (let j = 0; j < k; j++) {
        indexes[o + j] = order[j];
        weights[o + j] = 1 / Math.max(dist[order[j]] ** 2, 1e-6);
      }
    }
  }
  return { indexes, weights, k, W, H };
}

function interpolate(interp, values) {
  const { indexes, weights, k, W, H } = interp;
  const n = W * H;
  const out = new Float32Array(n).fill(NaN);
  for (let p = 0; p < n; p++) {
    let sw = 0;
    let sv = 0;
    for (let j = 0; j < k; j++) {
      const v = values[indexes[p * k + j]];
      if (typeof v !== "number" || Number.isNaN(v)) continue;
      const w = weights[p * k + j];
      sw += w;
      sv += w * v;
    }
    if (sw > 0) out[p] = sv / sw;
  }
  return out;
}

function crc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crc32Table();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([lenBuf, body, crcBuf]);
}

// Encodeur PNG minimal (RGBA 8 bits, sans dependance externe) : un filtre
// "none" par ligne + deflate via zlib (module natif Node).
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function renderField(field, layer, W, H) {
  const rgba = Buffer.alloc(W * H * 4);
  const opacity = layer.opacity ?? 224;
  for (let p = 0; p < field.length; p++) {
    const value = field[p];
    const o = p * 4;
    if (Number.isNaN(value) || (layer.transparentBelow !== undefined && value < layer.transparentBelow)) continue;
    const [r, g, b] = colorForValue(value, layer.stops, layer.discrete);
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = opacity;
  }
  return rgba;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(ROOT, args.outputDir);
  const depPath = path.join(outputDir, "departements", "66.json");

  let dep;
  try {
    dep = JSON.parse(await readFile(depPath, "utf-8"));
  } catch {
    console.log("Pas de nouveau fichier departement 66 (run deja a jour) : rien a cartographier.");
    return;
  }

  let runTime;
  try {
    const index = JSON.parse(await readFile(path.join(outputDir, "index.json"), "utf-8"));
    runTime = index.model?.run_time;
  } catch {
    runTime = undefined;
  }

  const geojson = JSON.parse(await readFile(path.join(ROOT, "config", "departement-66.geojson"), "utf-8"));
  const ring = geojson.features[0].geometry.coordinates[0];
  const lons = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  const bounds = {
    west: Math.min(...lons) - BUFFER_DEG,
    east: Math.max(...lons) + BUFFER_DEG,
    south: Math.min(...lats) - BUFFER_DEG,
    north: Math.max(...lats) + BUFFER_DEG,
  };
  const lonScale = Math.cos(((bounds.south + bounds.north) / 2) * (Math.PI / 180));

  const points = dep.points.map((p) => [p[2], p[1]]); // [lon, lat]
  const interpFine = buildInterpolation(bounds, points, lonScale, WIDTH, HEIGHT);
  const interpSharp = buildInterpolation(bounds, points, lonScale, WIDTH * DISCRETE_SCALE, HEIGHT * DISCRETE_SCALE);

  const steps = dep.forecast.map(([isoTime], t) => ({ lead_hour: t, valid_time: isoTime, files: {} }));
  const usedLayers = [];

  for (const layer of LAYERS) {
    const col = dep.columns.values.indexOf(layer.column);
    if (col < 0) continue;
    const interp = layer.discrete ? interpSharp : interpFine;
    const dir = path.join(outputDir, "maps", layer.key);
    await mkdir(dir, { recursive: true });
    const running = new Array(points.length).fill(0);
    let wrote = 0;
    for (let t = 0; t < dep.forecast.length; t++) {
      const rows = dep.forecast[t][1];
      let values = rows.map((r) => r[col]);
      if (layer.cumulative) {
        values = values.map((v, i) => {
          if (typeof v === "number") running[i] += v;
          return running[i];
        });
      }
      if (!values.some((v) => typeof v === "number")) continue;
      const rgba = renderField(interpolate(interp, values), layer, interp.W, interp.H);
      const fileName = `${String(t).padStart(3, "0")}.png`;
      await writeFile(path.join(dir, fileName), encodePng(interp.W, interp.H, rgba));
      steps[t].files[layer.key] = `maps/${layer.key}/${fileName}`;
      wrote++;
    }
    if (wrote) usedLayers.push(layer);
  }

  const manifest = {
    schema_version: 1,
    status: "ok",
    generated_at: dep.generated_at,
    run_time: runTime,
    width: WIDTH,
    height: HEIGHT,
    bounds,
    layers: Object.fromEntries(
      usedLayers.map((l) => [l.key, { stops: l.stops.map(([value, color]) => ({ value, color })) }]),
    ),
    steps,
  };
  await writeFile(path.join(outputDir, "maps", "index.json"), JSON.stringify(manifest));
  console.log(`Cartes generees : ${usedLayers.length} couches, ${steps.length} echeances, ${WIDTH}x${HEIGHT}px, departement 66 uniquement.`);
}

main().catch((error) => {
  console.error("ECHEC :", error);
  process.exitCode = 1;
});
