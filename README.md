# harmonie-dmi-2km

Pipeline HARMONIE-AROME (DINI, DMI Danemark) a resolution native **2 km**,
limite au departement **66 (Pyrenees-Orientales)**, pour le site
[app.alertes-meteo.com](https://app.alertes-meteo.com).

Ce depot est un complement du pipeline [`harmonie`](https://github.com/alertesmeteo-hub/harmonie)
(KNMI, 5.5 km, France entiere) — les deux modeles restent publies en
parallele sur le site : HARMONIE KNMI pour la couverture nationale,
HARMONIE DMI pour la meilleure resolution disponible gratuitement sur les
Pyrenees-Orientales.

## Source des donnees

[DMI Open Data — Forecast EDR API](https://opendataapi.dmi.dk/v1/forecastedr/),
collection `harmonie_dini_sf` ("HARMONIE DINI SF"). Gratuite, sans cle API,
domaine couvrant l'Islande jusqu'a l'Espagne (bbox `[-43.17, 37.69, 40.07,
69.91]`), largement suffisant pour le 66.

- Nouveaux runs a 00/03/06/09/12/15/18/21Z, disponibles publiquement
  environ 2h30-3h plus tard.
- Le pipeline decouvre le run courant via l'endpoint
  `/collections/harmonie_dini_sf/instances` (le plus recent des runs
  listes) plutot que de deviner l'heure : c'est fiable et tres bon marche
  (une seule requete legere).
- Les donnees sont recuperees via l'endpoint `/position` (un point a la
  fois, coordonnees WGS84 `crs84`) : `/cube` (bbox) exige la projection
  Lambert conique conforme native de ce modele pour DINI/IG, ce qui aurait
  complique le pipeline pour un gain marginal vu le nombre de points geres
  ici (quelques centaines tout au plus).
- L'API est mutualisee et repond parfois `429 Server is busy` : toutes les
  requetes passent par un backoff exponentiel poli (depart ~2.5s, plafond
  ~30s, abandon propre apres plusieurs tentatives — voir
  `fetchWithRetry()` dans le script).

## Grille et communes

- Grille reguliere generee a l'interieur (+ quelques km de marge) du
  polygone du departement 66 (`config/departement-66.geojson`, extrait du
  depot `harmonie` — IGN Admin Express, licence ouverte Etalab), avec un
  pas resserre jusqu'a rester sous ~220 points. C'est un sous-echantillon
  de la grille native 2 km du DMI (chaque point interroge est resolu par
  l'API au point de grille natif le plus proche) — meme principe que le
  pipeline KNMI qui n'interroge pas non plus tous les points a 5.5 km.
- Chaque commune du departement (`config/communes-66.json`, 226 communes,
  extrait de `communes-france.json` du depot `harmonie`) est rattachee au
  point de grille le plus proche (`point_id`, index dans le tableau
  `points` du fichier de sortie).

## Champs publies

Le modele DMI ne publie pas les memes diagnostics que HARMONIE-AROME P3
(pas de CAPE/CIN complets, pas de profil orageux, pas de niveaux de
pression standard) : le perimetre est volontairement plus reduit,
concentre sur les champs effectivement utilises par l'app (`AnimationModule.tsx`,
carte-modele) :

`temperature_c, humidity_pct, precipitation_mm, cloud_cover_pct,
cloud_low_pct, cloud_mid_pct, cloud_high_pct, wind_speed_kmh,
wind_direction_deg, wind_gust_kmh, pressure_hpa, visibility_km,
dewpoint_c, cape_jkg, snowfall_mm, condition_code`

Notes de conversion :

- `precipitation_mm` et `snowfall_mm` sont des **cumuls depuis le debut du
  run** cote DMI (`total-precipitation`, `total-snowfall-rate-water-equivalent`,
  verifie empiriquement : la serie est croissante) — le script les
  transforme en **quantite horaire** en differenciant deux echeances
  consecutives (clampee a 0 pour absorber le bruit d'interpolation).
- `condition_code` (1-9, voir `condition_codes` dans `index.json`) est
  **synthetise** a partir de la nebulosite, la visibilite, le cumul de
  precipitation horaire et le champ DMI `precipitation-type` (pluie/neige/
  verglas) — le DMI ne publie pas de code temps direct.
- L'altitude des points (`model_altitude_m`) est derivee du champ DMI
  `geopotential` (parametre ECMWF 129, orographie) divise par 9.80665.

## Fonctionnement

Une GitHub Action ([`update-harmonie-dmi.yml`](.github/workflows/update-harmonie-dmi.yml))
tourne environ toutes les heures (best-effort cote GitHub) :

1. Interroge `/instances` : si le run deja publie sur la branche `data` est
   toujours le plus recent, elle s'arrete la (cout quasi nul).
2. Sinon, recupere les previsions DMI pour tous les points de grille
   (`scripts/update-harmonie-dmi.mjs`, Node.js, aucune dependance externe).
3. Publie `index.json` + `departements/66.json` en ecrasant la branche
   [`data`](../../tree/data) (meme technique que le depot `harmonie` :
   commit unique sur une branche orpheline, fichiers a la racine).

## Structure du depot

```
.github/workflows/update-harmonie-dmi.yml   Action planifiee (branche data)
config/departement-66.geojson               Contour du departement 66 (extrait de harmonie)
config/communes-66.json                     226 communes du 66 (extrait de harmonie)
scripts/update-harmonie-dmi.mjs             Pipeline (fetch DMI -> index.json / departements/66.json)
```
