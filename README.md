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
- Les donnees sont recuperees via l'endpoint `/cube` : **une requete par lot
  de parametres** (2 lots, limite DMI de 1000 echeances x parametres) renvoie
  toute la grille native 2 km autour du departement (~70 x 45 mailles). Le
  `/cube` n'accepte que la projection native (`crs=native`) : Lambert
  conique conforme tangent a 55,5 N, meridien d'origine -8, sphere de rayon
  6 371 229 m, **coordonnees en kilometres** (grille 1906 x 1606 au pas de
  2 km). `versLambert()` / `versLonLat()` font la conversion ; le point de
  grille renvoye par `/position` pour Perpignan tombe exactement sur un noeud
  du `/cube`. Il repond en CoverageJSON (`application/prs.coverage+json`).
- Avant le passage au `/cube`, le pipeline faisait deux requetes `/position`
  par point : l'API, mutualisee, repondait `429 Server is busy` au bout de
  quelques dizaines de requetes, d'ou une grille limitee a ~26-40 points.
  Les 2 requetes restantes passent par un backoff exponentiel poli (depart
  5 s, plafond 60 s, 14 essais — voir `fetchWithRetry()`), et les lots deja
  recuperes sont gardes en cache pour le passage suivant.

## Grille et communes

- Zone demandee : le rectangle natif qui contient le polygone du departement
  66 (`config/departement-66.geojson`, extrait du depot `harmonie` — IGN
  Admin Express, licence ouverte Etalab), plus 4 km de marge.
- Chaque commune du departement (`config/communes-66.json`, 226 communes,
  extrait de `communes-france.json` du depot `harmonie`) prend **la maille
  native 2 km qui la contient** ; une maille partagee par deux communes
  n'est publiee qu'une fois (`point_id`, index dans le tableau `points` du
  fichier de sortie). Meme principe que le pipeline AROME (un point par
  commune).

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
2. Sinon, recupere les previsions DMI de la zone en deux requetes `/cube`
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
