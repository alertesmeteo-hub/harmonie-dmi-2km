#!/usr/bin/env node
// Pipeline HARMONIE DINI (DMI, Danemark) a 2 km natif pour le departement
// 66 (Pyrenees-Orientales) uniquement.
//
// Source : DMI Open Data EDR API, collection "harmonie_dini_sf"
//   https://opendataapi.dmi.dk/v1/forecastedr/collections/harmonie_dini_sf
// Gratuite, sans cle API. On interroge l'endpoint /position (point par
// point, coordonnees WGS84 crs84) : le /cube (bbox) exige la projection
// Lambert native pour ce modele et complique inutilement le pipeline vu le
// faible nombre de points necessaires pour un seul departement.
//
// Cette API est mutualisee et repond parfois "429 Server is busy" : toutes
// les requetes passent par fetchWithRetry() (backoff exponentiel, poli).
//
// Usage :
//   node scripts/update-harmonie-dmi.mjs \
//     --output-dir build/national \
//     --current-metadata-url https://raw.githubusercontent.com/<repo>/data/index.json \
//     [--force]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const API_BASE = "https://opendataapi.dmi.dk/v1/forecastedr/collections/harmonie_dini_sf";
const COLLECTION = "harmonie_dini_sf";
const PIPELINE_VERSION = 1;
const USER_AGENT = "alertesmeteo-hub/harmonie-dmi-2km (contact: alertes.meteo@gmail.com)";

// Parametres DMI demandes par point. `geopotential` (sans niveau = ECMWF
// param 129, orographie) sert uniquement a deriver l'altitude du point ;
// `precipitation-type` sert uniquement a affiner condition_code. Aucun des
// deux n'est publie tel quel dans les colonnes de sortie.
//
// L'API DMI refuse une requete si (nombre d'echeances x nombre de
// parametres) depasse 1000 (HTTP 413 "Too many model steps and/or
// parameters"). Avec ~61-79 echeances, on ne peut pas demander les 17
// parametres en une fois : ils sont donc repartis en deux lots, chacun
// recupere par une requete /position distincte pour le meme point.
const DMI_PARAMETER_BATCHES = [
  [
    "temperature-2m",
    "dew-point-temperature-2m",
    "relative-humidity-2m",
    "wind-speed-10m",
    "wind-dir-10m",
    "gust-wind-speed-10m",
    "pressure-sealevel",
    "visibility",
    "geopotential",
  ],
  [
    "low-cloud-cover",
    "medium-cloud-cover",
    "high-cloud-cover",
    "fraction-of-cloud-cover",
    "total-precipitation",
    "total-snowfall-rate-water-equivalent",
    "precipitation-type",
    "convective-available-potential-energy",
  ],
];
const DMI_PARAMETERS = DMI_PARAMETER_BATCHES.flat();

// Colonnes publiees dans departements/66.json, dans cet ordre.
const VALUE_COLUMNS = [
  "temperature_c",
  "humidity_pct",
  "precipitation_mm",
  "cloud_cover_pct",
  "cloud_low_pct",
  "cloud_mid_pct",
  "cloud_high_pct",
  "wind_speed_kmh",
  "wind_direction_deg",
  "wind_gust_kmh",
  "pressure_hpa",
  "visibility_km",
  "dewpoint_c",
  "cape_jkg",
  "snowfall_mm",
  "condition_code",
];

const CONDITION_CODES = {
  0: "unknown",
  1: "clear",
  2: "partly_cloudy",
  3: "cloudy",
  4: "overcast",
  5: "rain",
  6: "heavy_rain",
  7: "snow",
  8: "fog",
  9: "windy",
};

function parseArgs(argv) {
  const args = {
    outputDir: "build/national",
    currentMetadataUrl: "",
    force: false,
    // Grille volontairement plus grossiere (~40 points) : l'API DMI est durablement saturee
    // (HTTP 429) sur ce point d'acces. Deux tentatives d'augmentation ont echoue : 114-140 points
    // (grille native ~6 km, jamais reussi meme avec 120 min de timeout) et ~80 points a 0,065 deg
    // (echec confirme le 2026-10-01 : 36/63 points en echec apres 1h53, voir run Github Actions
    // 36832056488). Rester a ~40 points est la seule configuration fiable trouvee a ce jour.
    gridSpacingDeg: 0.09, // ~10 km en latitude a cette latitude
    maxPoints: 40,
    concurrency: 1,
    pacingMs: 400,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output-dir") args.outputDir = argv[++i];
    else if (a === "--current-metadata-url") args.currentMetadataUrl = argv[++i];
    else if (a === "--force") args.force = true;
    else if (a === "--grid-spacing-deg") args.gridSpacingDeg = Number(argv[++i]);
    else if (a === "--max-points") args.maxPoints = Number(argv[++i]);
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--pacing-ms") args.pacingMs = Number(argv[++i]);
    else throw new Error(`Argument inconnu : ${a}`);
  }
  return args;
}

function log(...parts) {
  const ts = new Date().toISOString();
  console.log(`${ts} | ${parts.join(" ")}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Requete HTTP polie : backoff exponentiel a partir de ~2.5s, plafonne a
// ~30s d'attente entre essais, abandon propre apres `maxAttempts`.
async function fetchWithRetry(url, { maxAttempts = 7, baseDelayMs = 2500, maxDelayMs = 30000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (response.status === 200) {
        return response.json();
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status} (${await response.text().catch(() => "")})`);
      } else {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} sur ${url} : ${body.slice(0, 300)}`);
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < maxAttempts) {
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      log(`  Tentative ${attempt}/${maxAttempts} echouee (${lastError.message}) - nouvel essai dans ${(delay / 1000).toFixed(1)}s`);
      await sleep(delay);
    }
  }
  throw new Error(`Echec apres ${maxAttempts} tentatives sur ${url} : ${lastError?.message}`);
}

async function fetchLatestInstance() {
  const data = await fetchWithRetry(`${API_BASE}/instances`, { maxAttempts: 6, baseDelayMs: 2000 });
  const instances = data.instances || [];
  if (!instances.length) throw new Error("Aucune instance HARMONIE DINI publiee par le DMI");
  // Le premier element est le run le plus recent (confirme empiriquement).
  const latest = instances[0];
  const id = latest.id; // ex: "2026-09-29T030000Z"
  const match = id.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) throw new Error(`Format d'instance DMI inattendu : ${id}`);
  const [, y, mo, d, h, mi, s] = match;
  const runTime = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  return { instanceId: id, runTime, availableInstances: instances.map((i) => i.id) };
}

async function alreadyPublished(url, runTime) {
  if (!url) return false;
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (response.status !== 200) return false;
    const payload = await response.json();
    return payload?.status === "ok" && payload?.model?.run_time === runTime && payload?.model?.pipeline_version === PIPELINE_VERSION;
  } catch {
    return false;
  }
}

// --- Geometrie : point-in-polygon (ray casting) + grille reguliere ---

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon, lat, polygonCoordinates) {
  // GeoJSON Polygon : [outerRing, hole1, hole2, ...]. On ignore les trous
  // (aucun departement francais n'en a).
  if (!polygonCoordinates.length) return false;
  return pointInRing(lon, lat, polygonCoordinates[0]);
}

function distancePointToSegmentKm(lon, lat, [x1, y1], [x2, y2]) {
  // Approximation planaire suffisante a l'echelle d'un departement.
  const kx = 82; // km par degre de longitude a ~42.6N
  const ky = 111; // km par degre de latitude
  const px = lon * kx;
  const py = lat * ky;
  const ax = x1 * kx;
  const ay = y1 * ky;
  const bx = x2 * kx;
  const by = y2 * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distanceToPolygonBoundaryKm(lon, lat, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    best = Math.min(best, distancePointToSegmentKm(lon, lat, ring[j], ring[i]));
  }
  return best;
}

function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function buildGrid(polygonCoordinates, spacingDeg, bufferKm = 4) {
  const ring = polygonCoordinates[0];
  const lons = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const lonStep = spacingDeg * 1.35; // compense la contraction est-ouest a cette latitude
  const latStep = spacingDeg;
  const points = [];
  for (let lat = minLat; lat <= maxLat + latStep / 2; lat += latStep) {
    for (let lon = minLon; lon <= maxLon + lonStep / 2; lon += lonStep) {
      const inside = pointInPolygon(lon, lat, polygonCoordinates);
      const nearBoundary = !inside && distanceToPolygonBoundaryKm(lon, lat, ring) <= bufferKm;
      if (inside || nearBoundary) {
        points.push([Number(lon.toFixed(5)), Number(lat.toFixed(5))]);
      }
    }
  }
  return points;
}

// --- Traitement des reponses DMI ---

function toCoverageIndex(coverage, param) {
  const range = coverage.ranges?.[param];
  return range ? range.values : null;
}

function safeRound(value, decimals = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function computeConditionCode({ precipMm, snowMm, precipType, cloudPct, visKm, windKmh }) {
  if (visKm !== null && visKm < 1 && (cloudPct === null || cloudPct >= 50)) return 8; // brouillard
  const isSnowType = precipType === 2 || precipType === 3 || precipType === 4; // sleet/snow/freezing
  const totalPrecip = (precipMm ?? 0) + (snowMm ?? 0);
  if (isSnowType && totalPrecip > 0.05) return 7; // neige
  if ((precipMm ?? 0) > 4) return 6; // forte pluie
  if ((precipMm ?? 0) > 0.1) return 5; // pluie
  if (cloudPct === null) return 0;
  if (cloudPct >= 80) return 4; // couvert
  if (cloudPct >= 50) return 3; // nuageux
  if (cloudPct >= 20) return 2; // peu nuageux
  if (windKmh !== null && windKmh >= 50) return 9; // venteux
  return 1; // degage
}

async function fetchPoint(lon, lat, pacingMs = 0) {
  let times = null;
  const series = {};
  for (let b = 0; b < DMI_PARAMETER_BATCHES.length; b++) {
    const batch = DMI_PARAMETER_BATCHES[b];
    const url = `${API_BASE}/position?coords=${encodeURIComponent(`POINT(${lon} ${lat})`)}&parameter-name=${batch.join(",")}&crs=crs84`;
    const coverage = await fetchWithRetry(url);
    const batchTimes = coverage.domain?.axes?.t?.values;
    if (!batchTimes || !batchTimes.length) throw new Error(`Reponse DMI sans axe temporel pour ${lon},${lat}`);
    if (times === null) {
      times = batchTimes;
    } else if (batchTimes.length !== times.length || batchTimes[0] !== times[0]) {
      throw new Error(`Echeances incoherentes entre lots de parametres pour ${lon},${lat}`);
    }
    for (const param of batch) {
      series[param] = toCoverageIndex(coverage, param) || new Array(batchTimes.length).fill(null);
    }
    if (pacingMs > 0 && b < DMI_PARAMETER_BATCHES.length - 1) await sleep(pacingMs);
  }

  const geopotential = series["geopotential"].find((v) => typeof v === "number");
  const altitudeM = typeof geopotential === "number" ? Math.round(geopotential / 9.80665) : 0;

  const rows = [];
  let prevPrecip = null;
  let prevSnow = null;
  for (let i = 0; i < times.length; i++) {
    const tempK = series["temperature-2m"][i];
    const dewK = series["dew-point-temperature-2m"][i];
    const rh = series["relative-humidity-2m"][i];
    const windMs = series["wind-speed-10m"][i];
    const windDir = series["wind-dir-10m"][i];
    const gustMs = series["gust-wind-speed-10m"][i];
    const pressurePa = series["pressure-sealevel"][i];
    const visM = series["visibility"][i];
    const cloudLow = series["low-cloud-cover"][i];
    const cloudMid = series["medium-cloud-cover"][i];
    const cloudHigh = series["high-cloud-cover"][i];
    const cloudFrac = series["fraction-of-cloud-cover"][i];
    const cumPrecip = series["total-precipitation"][i];
    const cumSnow = series["total-snowfall-rate-water-equivalent"][i];
    const precipType = series["precipitation-type"][i];
    const cape = series["convective-available-potential-energy"][i];

    const precipMm = cumPrecip === null || prevPrecip === null ? 0 : Math.max(0, cumPrecip - prevPrecip);
    const snowMm = cumSnow === null || prevSnow === null ? 0 : Math.max(0, cumSnow - prevSnow);
    if (cumPrecip !== null) prevPrecip = cumPrecip;
    if (cumSnow !== null) prevSnow = cumSnow;

    const cloudCoverPct = typeof cloudFrac === "number" ? safeRound(cloudFrac * 100) : null;
    const visKm = typeof visM === "number" ? safeRound(Math.min(visM, 50000) / 1000, 1) : null;
    const windKmh = typeof windMs === "number" ? safeRound(windMs * 3.6) : null;

    const row = [
      typeof tempK === "number" ? safeRound(tempK - 273.15, 1) : null, // temperature_c
      typeof rh === "number" ? safeRound(rh) : null, // humidity_pct
      safeRound(precipMm, 2), // precipitation_mm
      cloudCoverPct, // cloud_cover_pct
      typeof cloudLow === "number" ? safeRound(cloudLow) : null, // cloud_low_pct
      typeof cloudMid === "number" ? safeRound(cloudMid) : null, // cloud_mid_pct
      typeof cloudHigh === "number" ? safeRound(cloudHigh) : null, // cloud_high_pct
      windKmh, // wind_speed_kmh
      typeof windDir === "number" ? safeRound(windDir) : null, // wind_direction_deg
      typeof gustMs === "number" ? safeRound(gustMs * 3.6) : null, // wind_gust_kmh
      typeof pressurePa === "number" ? safeRound(pressurePa / 100, 1) : null, // pressure_hpa
      visKm, // visibility_km
      typeof dewK === "number" ? safeRound(dewK - 273.15, 1) : null, // dewpoint_c
      typeof cape === "number" ? safeRound(cape) : null, // cape_jkg
      safeRound(snowMm, 2), // snowfall_mm
      computeConditionCode({ precipMm, snowMm, precipType, cloudPct: cloudCoverPct, visKm, windKmh }), // condition_code
    ];
    rows.push(row);
  }

  return { times, rows, altitudeM };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runOne() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, runOne);
  await Promise.all(workers);
  return results;
}

function nearestPointIndex(lon, lat, points) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = haversineKm(lon, lat, points[i][0], points[i][1]);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  log("Verification du dernier run HARMONIE DINI publie par le DMI...");
  const { instanceId, runTime, availableInstances } = await fetchLatestInstance();
  log(`Run le plus recent : ${instanceId} (run_time=${runTime}). Instances disponibles : ${availableInstances.join(", ")}`);

  if (!args.force && (await alreadyPublished(args.currentMetadataUrl, runTime))) {
    log("Run deja publie sur la branche data, rien a faire.");
    return;
  }

  const geojson = JSON.parse(await readFile(path.join(ROOT, "config", "departement-66.geojson"), "utf-8"));
  const feature = geojson.features[0];
  const polygonCoordinates = feature.geometry.coordinates;

  const communesRaw = JSON.parse(await readFile(path.join(ROOT, "config", "communes-66.json"), "utf-8"));
  const communeColumns = communesRaw.columns; // code_insee,name,postal_codes,population,latitude,longitude

  log("Construction de la grille de points sur le departement 66...");
  let gridPoints = buildGrid(polygonCoordinates, args.gridSpacingDeg);
  if (gridPoints.length > args.maxPoints) {
    // Elargit le pas jusqu'a repasser sous la limite plutot que de tronquer
    // arbitrairement la grille.
    let spacing = args.gridSpacingDeg;
    while (gridPoints.length > args.maxPoints) {
      spacing *= 1.15;
      gridPoints = buildGrid(polygonCoordinates, spacing);
    }
  }
  log(`Grille retenue : ${gridPoints.length} points (~${args.gridSpacingDeg.toFixed(3)}deg de pas).`);

  log(`Interrogation du DMI pour ${gridPoints.length} points (endpoint /position, ${DMI_PARAMETERS.length} parametres)...`);
  const startedAt = Date.now();
  let failedCount = 0;
  const fetchedRaw = await mapWithConcurrency(gridPoints, args.concurrency, async ([lon, lat], i) => {
    try {
      const result = await fetchPoint(lon, lat, args.pacingMs);
      if (args.pacingMs > 0) await sleep(args.pacingMs);
      if ((i + 1) % 20 === 0 || i === gridPoints.length - 1) {
        log(`  ${i + 1}/${gridPoints.length} points traites (${failedCount} echecs jusqu'ici)...`);
      }
      return result;
    } catch (error) {
      failedCount++;
      log(`  Point ${i} (${lon},${lat}) abandonne apres tous les essais : ${error.message}`);
      return null;
    }
  });
  log(`Recuperation terminee en ${((Date.now() - startedAt) / 1000).toFixed(0)}s (${failedCount}/${gridPoints.length} points en echec).`);

  if (failedCount > gridPoints.length * 0.3) {
    throw new Error(
      `Trop de points en echec (${failedCount}/${gridPoints.length}) - le DMI semble indisponible, abandon plutot que de publier un jeu de donnees incomplet.`
    );
  }

  // On ne conserve que les points effectivement recuperes, et on
  // renumerote model_index en consequence (0..n-1 dans l'ordre conserve).
  const okGridPoints = [];
  const fetched = [];
  gridPoints.forEach((gp, i) => {
    if (fetchedRaw[i] !== null) {
      okGridPoints.push(gp);
      fetched.push(fetchedRaw[i]);
    }
  });
  if (!fetched.length) throw new Error("Aucun point recupere avec succes.");

  const canonicalTimes = fetched[0].times;
  for (const f of fetched) {
    if (f.times.length !== canonicalTimes.length) {
      throw new Error("Nombre d'echeances incoherent entre points DMI (reponse partielle ?)");
    }
  }

  const points = okGridPoints.map(([lon, lat], i) => [i, lat, lon, fetched[i].altitudeM]);

  const communes = communesRaw.communes.map((c) => {
    const lat = c[communeColumns.indexOf("latitude")];
    const lon = c[communeColumns.indexOf("longitude")];
    const pointId = nearestPointIndex(lon, lat, okGridPoints);
    return [
      c[communeColumns.indexOf("code_insee")],
      c[communeColumns.indexOf("name")],
      c[communeColumns.indexOf("postal_codes")],
      c[communeColumns.indexOf("population")],
      lat,
      lon,
      pointId,
    ];
  });

  const forecast = canonicalTimes.map((iso, i) => [iso, fetched.map((f) => f.rows[i])]);

  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const model = {
    name: "HARMONIE DINI (Cy46)",
    provider: "DMI",
    dataset: COLLECTION,
    pipeline_version: PIPELINE_VERSION,
    catalog_version: 1,
    domain: "Islande-Espagne (DINI)",
    resolution_km: 2,
    forecast_hours_requested: canonicalTimes.length - 1,
    run_time: runTime,
    run_instance_id: instanceId,
    source_url: "https://opendataapi.dmi.dk/v1/forecastedr/collections/harmonie_dini_sf",
    license: "CC BY 4.0 (DMI Open Data)",
  };

  const departmentPayload = {
    schema_version: 2,
    status: "ok",
    generated_at: generatedAt,
    department: "66",
    columns: {
      points: ["model_index", "latitude", "longitude", "model_altitude_m"],
      communes: ["code_insee", "name", "postal_codes", "population", "latitude", "longitude", "point_id"],
      values: VALUE_COLUMNS,
    },
    points,
    communes,
    forecast,
  };

  const outputDir = path.resolve(ROOT, args.outputDir);
  const departmentsDir = path.join(outputDir, "departements");
  await mkdir(departmentsDir, { recursive: true });
  const departmentJson = JSON.stringify(departmentPayload);
  await writeFile(path.join(departmentsDir, "66.json"), departmentJson, "utf-8");

  const index = {
    schema_version: 2,
    status: "ok",
    generated_at: generatedAt,
    model,
    coverage: { label: "Pyrenees-Orientales (66)", communes: communes.length, departments: 1 },
    condition_codes: CONDITION_CODES,
    departments: {
      "66": {
        file: "departements/66.json",
        communes: communes.length,
        points: points.length,
        size_bytes: Buffer.byteLength(departmentJson, "utf-8"),
      },
    },
  };
  await writeFile(path.join(outputDir, "index.json"), JSON.stringify(index), "utf-8");

  log(`Publie : ${points.length} points, ${communes.length} communes, ${canonicalTimes.length} echeances (run ${runTime}).`);
}

main().catch((error) => {
  console.error("ECHEC :", error);
  process.exitCode = 1;
});
