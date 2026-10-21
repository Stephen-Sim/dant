# Windows timezone mapping

`windows-timezones.json` is generated from the IANA comments in the official **Go 1.27.2** [`src/time/zoneinfo_abbrs_windows.go`](https://github.com/golang/go/blob/go1.27.2/src/time/zoneinfo_abbrs_windows.go). Go generated those Windows key/default-zone pairs from Unicode CLDR. The 139 rows are a pinned data projection, not an offset or localized display-name heuristic. The shared i18n validator canonicalizes aliases to the existing wire contract.

The JSON records its exact normalized source SHA-256 and copyright. `GO-LICENSE.txt` retains the full Go Authors BSD license. Derived data retains the original source copyright notice. No data is fetched at runtime.

Reproduce with the repository's pinned compiler installation:

```powershell
node scripts/core/generate-timezones.mts
node scripts/core/generate-timezones.mts --check
```

Platform tests compare every row and the source digest with that exact toolchain, validate every mapped IANA name and verify the retained license. An intentional toolchain/data update must regenerate and review the digest and all rows together. Native lookup uses the [documented dynamic timezone key](https://learn.microsoft.com/windows/win32/api/timezoneapi/ns-timezoneapi-dynamic_time_zone_information); it does not guess from `StandardName`, `DaylightName`, current UTC offsets or abbreviations.
