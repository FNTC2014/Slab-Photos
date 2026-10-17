# Slab Plates

An Android app that turns photos of graded coins into square plates: obverse and reverse side by side with the certificate underneath, in true colour.

- Finds, crops and straightens each coin and the certificate automatically, turning each coin upright by matching its design against Canadian coin types from 1858 to 1967
- Reads ICCS and PCGS labels on the phone (no account, no cost, works offline)
- Batch mode for a whole session of photos
- Saves plates to **Pictures/Slab Plates**, named to sort by date, denomination, grade, comment and certificate

## Install

Open the [latest release](../../releases/latest) on your phone, download `SlabPlates.apk` and open it. Android will ask once to allow installs from your browser or files app.

## Build

Every push to `main` builds a signed APK with GitHub Actions and publishes it as a release. The page itself lives in `src/` and is built into `www/` by `npm run build`.
