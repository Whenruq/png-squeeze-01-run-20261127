[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Whenruq/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Whenruq/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

# png-squeeze

A lossless PNG re-encoder in a single dependency-free `main.ts` (Node 22, only
`node:fs`, `node:path`, `node:zlib`).

For each 1280x720 RGBA screenshot it:

1. Decodes the stored PNG (chunk walk, inflate, full unfiltering).
2. Analyses the pixels once: fully opaque? grey? at most 256 distinct RGBA
   colours?
3. Builds candidate encodings — grey (type 0), grey+alpha (type 4), palette
   (type 3, with `tRNS` when some entries are translucent), RGB (type 2) or
   RGBA (type 6) — and, when a palette and a direct type both apply, keeps
   whichever final file is smaller.
4. Filters each candidate two ways — per-row adaptive choice among
   None/Sub/Up/Average/Paeth minimising MSAD (sum of absolute signed filtered
   bytes), and fixed Paeth on every row — compresses both with zlib at
   level 9 / memLevel 9, and keeps the smaller result.
5. Writes a minimal PNG: signature, IHDR, PLTE/tRNS when needed, a single
   IDAT, IEND, with a table-based CRC32.

Output is deterministic: the same input always produces the same bytes.
