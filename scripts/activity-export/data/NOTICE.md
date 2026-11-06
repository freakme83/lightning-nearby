# Ankara district boundaries — source and licence

`ankara-districts.geojson` contains the 25 districts of Ankara province (TR-06), extracted
unchanged from:

- **Dataset:** geoBoundaries gbOpen TUR ADM2 "Districts" (boundary ID `TUR-ADM2-54988432`,
  boundary year 2021, source data updated 2023-01-19, built 2023-12-12)
- **File:** `releaseData/gbOpen/TUR/ADM2/geoBoundaries-TUR-ADM2.geojson` in
  https://github.com/wmgeolab/geoBoundaries at commit `8ce2700661a28ee944350e2b329bbabb58d2ff83`
  (Git LFS object, SHA-256 `8e7594ab12d916e3b93f920475a300c364dfb94a0e40bfa6d55f43aff0c7fd97`)
- **Upstream source:** OpenStreetMap via OSM Boundaries (osm-boundaries.com)
- **Licence:** Open Data Commons Open Database License 1.0 (ODbL-1.0),
  https://opendatacommons.org/licenses/odbl/1-0/

Attribution: © OpenStreetMap contributors (https://www.openstreetmap.org/copyright).
District boundaries via geoBoundaries — Runfola, D. et al. (2020) geoBoundaries: A global database
of political administrative boundaries. PLoS ONE 15(4): e0231866.
https://doi.org/10.1371/journal.pone.0231866

This extract is a derivative database of the source and is made available under the same
ODbL-1.0 licence. Features were selected by pinned `shapeID`; coordinates were not simplified,
rounded or repaired. Regenerate and verify it offline with:

```sh
node --experimental-strip-types scripts/activity-export/extract-districts.ts <geoBoundaries-TUR-ADM2.geojson> <output.geojson>
```

The script refuses a source file whose SHA-256 differs from the pinned value.
