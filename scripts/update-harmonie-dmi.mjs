#!/usr/bin/env node
// Pipeline HARMONIE DINI (DMI, Danemark) a 2 km natif pour le departement
// 66 (Pyrenees-Orientales) uniquement.
//
// Source : DMI Open Data EDR API, collection "harmonie_dini_sf"
//   https://opendataapi.dmi.dk/v1/forecastedr/collections/harmonie_dini_sf
// Gratuite, sans cle API. On interroge l'endpoint /cube : UNE requete par lot
// de parametres renvoie toute la grille native 2 km autour du departement
// (~72 x 49 mailles), au lieu de deux requetes /position par point. Le /cube
// n'accepte que la projection native (Lambert conique conforme, coordonnees
// en kilometres) : versLambert()/versLonLat() font la conversion.
//
// Cette API est mutualisee et repond souvent "429 Server is busy" : toutes
// les requetes passent par fetchWithRetry() (backoff exponentiel, poli). Avec
// 2 requetes par run (au lieu de ~80 en point par point), la saturation ne
// bloque plus la publication.
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
// 2 : grille native 2 km via /cube, une maille par commune (au lieu de ~26 a 40 points /position).
const PIPELINE_VERSION = 2;
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
// recupere par une requete /cube distincte.
const DMI_PARAMETER_BATCHES = [
  [
    "temperature-2m",
    "dew-point-temperature-2m",
    "relative-humidity-2m",
    // En crs=native, le /cube refuse wind-speed-10m et wind-dir-10m (calcules seulement pour /position) :
    // on demande les composantes u et v, dont on tire vitesse et direction (voir ventDepuisUV()).
    "wind-10m-u",
    "wind-10m-v",
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
    // Lots /cube deja recuperes pour le run en cours : conserves d'une tentative a l'autre (cache du workflow),
    // pour qu'un passage interrompu par un DMI sature ne redemande que le lot manquant.
    cacheDir: ".cache/dmi",
    // Marge (km) autour du departement dans la zone demandee : les communes du bord gardent leur maille.
    marginKm: 4,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output-dir") args.outputDir = argv[++i];
    else if (a === "--current-metadata-url") args.currentMetadataUrl = argv[++i];
    else if (a === "--force") args.force = true;
    else if (a === "--cache-dir") args.cacheDir = argv[++i];
    else if (a === "--margin-km") args.marginKm = Number(argv[++i]);
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
// Seuls les 429 / 5xx et les coupures reseau sont reessayes ; une autre erreur HTTP (400, 404, 406...) est definitive.
async function fetchWithRetry(url, { maxAttempts = 7, baseDelayMs = 2500, maxDelayMs = 30000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      // Le /cube repond en CoverageJSON (application/prs.coverage+json) : un Accept limite a application/json
      // lui fait renvoyer 406 "Could not find acceptable representation".
      response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/prs.coverage+json, application/json;q=0.9, */*;q=0.1" },
      });
      if (response.status === 200) {
        return await response.json();
      }
    } catch (error) {
      lastError = error;
    }
    if (response && response.status !== 200) {
      const body = await response.text().catch(() => "");
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`HTTP ${response.status} sur ${url} : ${body.slice(0, 300)}`);
      }
      lastError = new Error(`HTTP ${response.status} (${body.slice(0, 200)})`);
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

// --- Projection native DINI (WKT de la collection : "DMI HARMONIE DINI lambert projection") ---
// Lambert conique conforme tangent a 55,5 N, meridien d'origine -8, sphere de rayon 6 371 229 m, origine (0, 0).
// Le /cube attend et renvoie des coordonnees en KILOMETRES (grille 1906 x 1606, pas de 2 km). Verifie : le point
// de grille renvoye par /position pour Perpignan tombe exactement sur un noeud du /cube.
const LCC_R = 6371229;
const LCC_PHI1 = (55.5 * Math.PI) / 180;
const LCC_LAMBDA0 = (-8 * Math.PI) / 180;
const LCC_N = Math.sin(LCC_PHI1);
const LCC_F = (Math.cos(LCC_PHI1) * Math.tan(Math.PI / 4 + LCC_PHI1 / 2) ** LCC_N) / LCC_N;
const lccRho = (phi) => (LCC_R * LCC_F) / Math.tan(Math.PI / 4 + phi / 2) ** LCC_N;
const LCC_RHO0 = lccRho(LCC_PHI1);

function versLambert(lon, lat) {
  const rho = lccRho((lat * Math.PI) / 180);
  const theta = LCC_N * ((lon * Math.PI) / 180 - LCC_LAMBDA0);
  return [(rho * Math.sin(theta)) / 1000, (LCC_RHO0 - rho * Math.cos(theta)) / 1000];
}

function versLonLat(xKm, yKm) {
  const x = xKm * 1000;
  const y = yKm * 1000;
  const rho = Math.hypot(x, LCC_RHO0 - y);
  const theta = Math.atan2(x, LCC_RHO0 - y);
  const lon = ((theta / LCC_N + LCC_LAMBDA0) * 180) / Math.PI;
  const lat = ((2 * Math.atan(((LCC_R * LCC_F) / rho) ** (1 / LCC_N)) - Math.PI / 2) * 180) / Math.PI;
  return [lon, lat];
}

// Composantes u/v du vent : relatives aux axes de la grille Lambert (convention GRIB des grilles coniques). La
// direction vraie s'en deduit en ajoutant l'angle de convergence des meridiens, n x (lon - lon0) : ~8,6 degres a
// Perpignan. Mettre VENT_UV_RELATIF_GRILLE a false si le DMI publie un jour des composantes deja orientees au nord.
const VENT_UV_RELATIF_GRILLE = true;

function ventDepuisUV(u, v, lon) {
  if (typeof u !== "number" || typeof v !== "number") return { vitesse: null, direction: null };
  const rotation = VENT_UV_RELATIF_GRILLE ? (LCC_N * (lon * Math.PI) / 180 - LCC_N * LCC_LAMBDA0) * (180 / Math.PI) : 0;
  // Direction meteorologique : d'ou vient le vent, en degres depuis le nord, sens horaire.
  const directionGrille = (Math.atan2(-u, -v) * 180) / Math.PI;
  return { vitesse: Math.hypot(u, v), direction: (((directionGrille + rotation) % 360) + 360) % 360 };
}

// Zone native (km) couvrant le departement, plus une marge.
function bboxNative(ring, marginKm) {
  const xy = ring.map(([lon, lat]) => versLambert(lon, lat));
  const xs = xy.map((p) => p[0]);
  const ys = xy.map((p) => p[1]);
  return [Math.min(...xs) - marginKm, Math.min(...ys) - marginKm, Math.max(...xs) + marginKm, Math.max(...ys) + marginKm];
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

// Axe regulier CoverageJSON ({start, stop, num}) ou liste de valeurs -> liste de valeurs.
function valeursAxe(axe) {
  if (Array.isArray(axe.values)) return axe.values;
  if (axe.num === 1) return [axe.start];
  return Array.from({ length: axe.num }, (_, i) => axe.start + ((axe.stop - axe.start) * i) / (axe.num - 1));
}

// Un lot de parametres pour toute la zone : { times, xs, ys, ranges } (valeurs a plat, axes [t, y, x]).
async function fetchCube(bbox, batch) {
  const url = `${API_BASE}/cube?bbox=${bbox.map((v) => v.toFixed(3)).join(",")}&crs=native&parameter-name=${batch.join(",")}`;
  // Saturation frequente : beaucoup de patience (2 requetes seulement par run, ~30-60 s chacune cote DMI).
  const coverage = await fetchWithRetry(url, { maxAttempts: 14, baseDelayMs: 5000, maxDelayMs: 60000 });
  const axes = coverage.domain?.axes;
  if (!axes?.t || !axes?.x || !axes?.y) throw new Error("Reponse /cube DMI sans axes t, x, y");
  const ranges = {};
  for (const param of batch) {
    const range = coverage.ranges?.[param];
    if (!range) continue;
    const ordre = (range.axisNames || []).join(",");
    if (ordre !== "t,y,x") throw new Error(`Axes inattendus pour ${param} : ${ordre}`);
    ranges[param] = range.values;
  }
  return { times: valeursAxe(axes.t), xs: valeursAxe(axes.x), ys: valeursAxe(axes.y), ranges };
}

// Lignes de sortie (VALUE_COLUMNS) d'une maille a partir de ses series par parametre.
function construireLignes(times, series, lon) {
  const geopotential = series["geopotential"].find((v) => typeof v === "number");
  const altitudeM = typeof geopotential === "number" ? Math.round(geopotential / 9.80665) : 0;

  const rows = [];
  let prevPrecip = null;
  let prevSnow = null;
  for (let i = 0; i < times.length; i++) {
    const tempK = series["temperature-2m"][i];
    const dewK = series["dew-point-temperature-2m"][i];
    const rh = series["relative-humidity-2m"][i];
    const { vitesse: windMs, direction: windDir } = ventDepuisUV(series["wind-10m-u"][i], series["wind-10m-v"][i], lon);
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

  return { rows, altitudeM };
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

  const bbox = bboxNative(polygonCoordinates[0], args.marginKm);
  log(`Zone native demandee (km) : ${bbox.map((v) => v.toFixed(1)).join(", ")}`);

  // Cache des lots deja recuperes pour CE run (identifie par l'instance DMI).
  const cacheFile = path.join(args.cacheDir, "cubes.json");
  let cache = { instanceId, lots: {} };
  try {
    const saved = JSON.parse(await readFile(cacheFile, "utf-8"));
    if (saved.instanceId === instanceId && saved.lots) cache = saved;
  } catch {
    // pas de cache : premiere tentative pour ce run
  }
  await mkdir(args.cacheDir, { recursive: true });

  const startedAt = Date.now();
  const lots = [];
  for (let b = 0; b < DMI_PARAMETER_BATCHES.length; b++) {
    if (cache.lots[b]) {
      log(`Lot ${b + 1}/${DMI_PARAMETER_BATCHES.length} : deja en cache pour ce run.`);
    } else {
      log(`Lot ${b + 1}/${DMI_PARAMETER_BATCHES.length} : /cube (${DMI_PARAMETER_BATCHES[b].length} parametres)...`);
      cache.lots[b] = await fetchCube(bbox, DMI_PARAMETER_BATCHES[b]);
      await writeFile(cacheFile, JSON.stringify(cache), "utf-8");
    }
    lots.push(cache.lots[b]);
  }
  log(`Recuperation terminee en ${((Date.now() - startedAt) / 1000).toFixed(0)}s.`);

  const { times: canonicalTimes, xs, ys } = lots[0];
  for (const lot of lots) {
    if (lot.times.length !== canonicalTimes.length || lot.times[0] !== canonicalTimes[0]) {
      throw new Error("Echeances incoherentes entre lots de parametres DMI");
    }
    if (lot.xs.length !== xs.length || lot.ys.length !== ys.length || lot.xs[0] !== xs[0] || lot.ys[0] !== ys[0]) {
      throw new Error("Grilles incoherentes entre lots de parametres DMI");
    }
  }
  const nx = xs.length;
  const ny = ys.length;
  const nt = canonicalTimes.length;
  const pasX = nx > 1 ? (xs[nx - 1] - xs[0]) / (nx - 1) : 2;
  const pasY = ny > 1 ? (ys[ny - 1] - ys[0]) / (ny - 1) : 2;
  log(`Grille DMI : ${nx} x ${ny} mailles (pas ${pasX.toFixed(2)} x ${pasY.toFixed(2)} km), ${nt} echeances.`);

  // Chaque commune prend la maille native qui la contient ; une maille partagee n'est publiee qu'une fois.
  const mailles = new Map(); // "i,j" -> index du point publie
  const pointsIJ = [];
  const communeMaille = communesRaw.communes.map((c) => {
    const [x, y] = versLambert(c[communeColumns.indexOf("longitude")], c[communeColumns.indexOf("latitude")]);
    const i = Math.min(nx - 1, Math.max(0, Math.round((x - xs[0]) / pasX)));
    const j = Math.min(ny - 1, Math.max(0, Math.round((y - ys[0]) / pasY)));
    const cle = `${i},${j}`;
    if (!mailles.has(cle)) {
      mailles.set(cle, pointsIJ.length);
      pointsIJ.push([i, j]);
    }
    return mailles.get(cle);
  });

  const fetched = pointsIJ.map(([i, j]) => {
    const series = {};
    for (let b = 0; b < DMI_PARAMETER_BATCHES.length; b++) {
      for (const param of DMI_PARAMETER_BATCHES[b]) {
        const valeurs = lots[b].ranges[param];
        series[param] = Array.from({ length: nt }, (_, t) => {
          const v = valeurs ? valeurs[t * ny * nx + j * nx + i] : null;
          return typeof v === "number" ? v : null;
        });
      }
    }
    return construireLignes(canonicalTimes, series, versLonLat(xs[i], ys[j])[0]);
  });
  if (!fetched.length) throw new Error("Aucune maille DMI retenue.");

  const points = pointsIJ.map(([i, j], k) => {
    const [lon, lat] = versLonLat(xs[i], ys[j]);
    return [k, Number(lat.toFixed(5)), Number(lon.toFixed(5)), fetched[k].altitudeM];
  });

  const communes = communesRaw.communes.map((c, k) => [
    c[communeColumns.indexOf("code_insee")],
    c[communeColumns.indexOf("name")],
    c[communeColumns.indexOf("postal_codes")],
    c[communeColumns.indexOf("population")],
    c[communeColumns.indexOf("latitude")],
    c[communeColumns.indexOf("longitude")],
    communeMaille[k],
  ]);

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
