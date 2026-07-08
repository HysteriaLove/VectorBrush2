# Font001–004 forensics (MX2004, SWF7 static text)

Byte-level findings from the reference set, for the text tool
implementation. All files CWS (zlib), v7, 550×400 stage.

## Files

- **Font001** — four text blocks: Times New Roman 12pt, Wingdings 48pt,
  Yu Gothic Medium 48pt multi-line, MS UI Gothic 48pt bold+italic
  multi-line placed with a scale matrix (free-transformed).
- **Font002** — the same after ONE Break Apart: per-character DefineText
  blocks (deduped: repeated chars share a definition, placed at many
  depths), fonts re-subset (space glyph dropped).
- **Font003** — after a SECOND Break Apart: the broken text merges into
  ONE DefineShape v1 (black solid, fill1 convention, 21 contours,
  272 edges) at depth 1 with identity placement — the same planar-map
  shape character the editor edits. Plus two new RGB-colored blocks.
- **Font004** — adds 50%-alpha blocks: those use **DefineText2 (RGBA)**
  while RGB blocks in the same file stay DefineText v1.

## DefineFont2 (tag 48)

- One font tag per (family, bold, italic), SHARED by every text block
  using it; glyph subset = union of used characters, sorted by code.
- flags: 0x04 base — wideCodes ALWAYS (u16 codes even for ASCII),
  narrow u16 offsets, **hasLayout=0** (no advances/bounds/kerning in
  the font; MX bakes metrics into the text records at authoring time).
  +0x01 bold, +0x02 italic. langCode=1.
- Font name: length byte, then name INCLUDING a NUL terminator.
- Offset table (u16 from table start) + codeTableOffset u16.
- Glyph shapes: same record stream as DefineShape. fillbits=1,
  linebits=0; every contour opens with a style change {moveTo,
  **fill0=1**} (stage shapes use fill1 — Flash re-orients on
  break-apart). Coordinates in a 1024-unit EM square, y-down, baseline
  at y=0 (glyphs extend into negative y). Real TTFs are often
  2048/EM — MX rescales to 1024 and rounds.
- Space = a real glyph with zero edges (2 bytes: style nibbles + end).

## DefineText (11) / DefineText2 (33)

- v1 RGB unless any alpha < 255 → v2 RGBA. Chosen PER BLOCK (both
  coexist in Font004). Mirrors the DefineShape v1/v3 rule.
- Block matrix is IDENTITY; position lives in PlaceObject2 (same
  convention as the shape character).
- height = point size in twips (12pt → 240). Advances in twips, baked
  per glyph. glyphBits/advanceBits = minimum needed.
- First record flags 0x8E/0x8F (hasFont|hasColor|hasY[|hasX]); each
  additional LINE is a record with flags 0x83 carrying only x/y
  offsets. First-line yoff ≈ scaled ascent (220 for 12pt Times).

## Placement

- PlaceObject2 flags 0x06 (char + matrix), sequential depths; the
  merged shape sits at depth 1, text blocks above. Free transform on a
  text block = matrix in its PlaceObject2 (scale stored as 16.16
  fixed: 2.00653076171875).

## Break Apart

Two stages, both journal-worthy ops:
1. text → single-character text blocks (deduped definitions).
2. characters → geometry merged into the depth-1 planar-map shape.

## Conversion fidelity (ttf.js)

MX2004 converts from HINTED outlines (GDI-era rasterizer state we do
not replicate — it would take a TrueType instruction interpreter).
ttf.js converts the raw glyf data with the rules above; verified
against Font001: identical contour/segment structure and coordinates
within ±1/1024 EM (~0.02 px at render sizes), except where MX's
hinted source made different collinear-collapse decisions. Neither
hinted nor unhinted GDI GetGlyphOutline reproduces MX byte-for-byte
(tested); semantic fidelity is the achievable and sufficient bar —
imported SWF text keeps its embedded glyphs verbatim, so round-trips
of existing files are unaffected.
