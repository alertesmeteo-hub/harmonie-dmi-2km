#!/usr/bin/env node
// Produit des cartes PNG (temperature, pour l'instant) a partir des points
// deja recuperes par update-harmonie-dmi.mjs, pour le departement 66
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

// Memes paliers de couleur que le module HARMONIE (harmonie_maps.py), pour
// garder un rendu coherent entre modeles sur /carte-modele.
const TEMPERATURE_STOPS = [
  [-25, "#7209b7"],
  [-15, "#3a0ca3"],
  [-5, "#4361ee"],
  [0, "#4cc9f0"],
  [5, "#2ec4b6"],
  [10, "#52b788"],
  [15, "#a7d129"],
  [20, "#ffea00"],
  [25, "#ffb700"],
  [30, "#ff7b00"],
  [35, "#ff3d00"],
  [40, "#e01e37"],
  [45, "#9d0208"],
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

function colorForValue(value, stops) {
  if (value <= stops[0][0]) return hexToRgb(stops[0][1]);
  if (value >= stops[stops.length - 1][0]) return hexToRgb(stops[stops.length - 1][1]);
  for (let i = 0; i < stops.length - 1; i++) {
    const [v0, c0] = stops[i];
    const [v1, c1] = stops[i + 1];
    if (value >= v0 && value <= v1) {
      const f = v1 === v0 ? 0 : (value - v0) / (v1 - v0);
      const rgb0 = hexToRgb(c0);
      const rgb1 = hexToRgb(c1);
      return [0, 1, 2].map((k) => Math.round(rgb0[k] + (rgb1[k] - rgb0[k]) * f));
    }
  }
  return hexToRgb(stops[stops.length - 1][1]);
}

// Interpolation par pondération inverse a la distance (IDW), sur un nombre
// de points reduit (~30-40) : brute-force point par point, pas besoin d'un
// index spatial.
function idwInterpolate(lon, lat, points, values, lonScale) {
  let sumW = 0;
  let sumV = 0;
  let nearestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [plon, plat] = points[i];
    const v = values[i];
    if (v === null || v === undefined) continue;
    const dx = (lon - plon) * lonScale;
    const dy = lat - plat;
    const d = Math.hypot(dx, dy);
    nearestD = Math.min(nearestD, d);
    const w = 1 / Math.max(d * d, 1e-6);
    sumW += w;
    sumV += w * v;
  }
  if (sumW === 0) return null;
  return sumV / sumW;
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
    raw[y * (stride + 1)] = 0; // filtre "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // couleur RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
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
  const tempIdx = dep.columns.values.indexOf("temperature_c");

  const mapsDir = path.join(outputDir, "maps", "temperature");
  await mkdir(mapsDir, { recursive: true });

  const steps = [];
  for (let t = 0; t < dep.forecast.length; t++) {
    const [isoTime, rows] = dep.forecast[t];
    const values = rows.map((r) => r[tempIdx]);
    if (!values.some((v) => typeof v === "number")) continue;

    const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
    for (let y = 0; y < HEIGHT; y++) {
      const lat = bounds.north - (y / (HEIGHT - 1)) * (bounds.north - bounds.south);
      for (let x = 0; x < WIDTH; x++) {
        const lon = bounds.west + (x / (WIDTH - 1)) * (bounds.east - bounds.west);
        const value = idwInterpolate(lon, lat, points, values, lonScale);
        const o = (y * WIDTH + x) * 4;
        if (value === null) {
          rgba[o + 3] = 0;
          continue;
        }
        const [r, g, b] = colorForValue(value, TEMPERATURE_STOPS);
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 224;
      }
    }

    const fileName = `${String(t).padStart(3, "0")}.png`;
    await writeFile(path.join(mapsDir, fileName), encodePng(WIDTH, HEIGHT, rgba));
    steps.push({ lead_hour: t, valid_time: isoTime, files: { temperature: `maps/temperature/${fileName}` } });
  }

  const manifest = {
    schema_version: 1,
    status: "ok",
    generated_at: dep.generated_at,
    run_time: runTime,
    width: WIDTH,
    height: HEIGHT,
    bounds,
    layers: {
      temperature: { stops: TEMPERATURE_STOPS.map(([value, color]) => ({ value, color })) },
    },
    steps,
  };
  await writeFile(path.join(outputDir, "maps", "index.json"), JSON.stringify(manifest));
  console.log(`Cartes generees : ${steps.length} echeances, ${WIDTH}x${HEIGHT}px, departement 66 uniquement.`);
}

main().catch((error) => {
  console.error("ECHEC :", error);
  process.exitCode = 1;
});
