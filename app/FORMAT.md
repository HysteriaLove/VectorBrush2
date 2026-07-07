# VBD — VectorBrush Drawing format, version 1

`.vbd` is VectorBrush's compact binary transmission format. It is modeled
directly on Flash's `DefineShape` encoding — the same bit-level tricks that
made SWF small — without the SWF container overhead (no tag headers, no
character IDs, no PlaceObject).

On the reference corpus (`SWFExamples/`), VBD files are equal to or smaller
than the SWF originals in every case (e.g. `Stress004`: 35,967 B vs 36,186 B).

## Why it's compact

1. **Integer twips** (1/20 px) — all coordinates are small integers.
2. **Delta-coded edges** — each edge stores deltas from the pen position,
   bit-packed at the minimum signed width for that edge (2–17 bits per
   component), with the horizontal/vertical shortcut for axis-aligned lines.
3. **Style tables + tiny indices** — colors and widths live once in tables;
   edges reference them with ceil(log2(count)) bits, re-selected only on
   change.
4. **Pen continuity** — the encoder orders edges so the next edge usually
   starts where the last one ended, and prefers same-style continuations, so
   moveTo and style records amortize away (Flash's own encoder does this).
5. **Optional deflate** over the whole body, kept only when it actually
   shrinks the payload (flag bit 0).

## Layout

All multi-byte integers are little-endian. Bit fields are MSB-first within
bytes (SWF convention). `UB[n]`/`SB[n]` are unsigned/signed bit fields.

```
"VBD1"          4 bytes   magic
flags           u8        bit0: body is zlib-deflate compressed
--- body (possibly compressed from here) ---
version         u8        = 1
stage           RECT      {xmin=0, xmax=width, ymin=0, ymax=height} twips
                          RECT = UB[5] nbits, then 4 × SB[nbits]
background      4 bytes   RGBA
fillCount       u8        0xFF escapes to a following u16
  per fill:
    type        u8        0 = solid (only type in v1; others reserved)
    color       4 bytes   RGBA
lineCount       u8        0xFF escapes to a following u16
  per line:
    width       u16       twips
    color       4 bytes   RGBA
(byte align)
numFillBits     UB[4]     bit width of fill indices  = ubits(fillCount)
numLineBits     UB[4]     bit width of line indices  = ubits(lineCount)
records         ...       see below, ends with the end record
```

### Records (SWF DefineShape grammar)

Each record starts with a 1-bit type flag.

**Non-edge record** (`0`), followed by `UB[5]` flags; all zero = **end record**.
Otherwise, in this order:

| flag bit | meaning | payload |
|---|---|---|
| 16 | NewStyles | reserved — never emitted, decoders must reject in v1 |
| 1 | MoveTo | `UB[5]` nbits, then absolute `SB[nbits]` x, y (twips) |
| 2 | FillStyle0 | `UB[numFillBits]` index (0 = none) |
| 4 | FillStyle1 | `UB[numFillBits]` index |
| 8 | LineStyle | `UB[numLineBits]` index |

(Payloads are written MoveTo first, then fill0, fill1, line — the SWF order.)

**Edge record** (`1`), then 1 bit: straight (`1`) / curved (`0`),
then `UB[4]` = nbits − 2.

- Straight: 1 bit general-line flag. General: `SB[nbits]` dx, dy.
  Otherwise 1 bit vertical flag, then a single `SB[nbits]` delta.
- Curved (quadratic Bézier): `SB[nbits]` control-dx, control-dy,
  anchor-dx, anchor-dy — control point relative to pen, anchor relative to
  control point.

After the end record the stream is byte-aligned; nothing follows in v1.

## Semantics

The decoded edge set is a **planar map**, exactly Flash's model:

- `fill1` = fill style on the forward side of the edge, `fill0` = fill on the
  reverse side, `line` = stroked line style; index 0 always means "none".
- To reconstruct fill *F*'s region: every `fill1 == F` edge forward plus every
  `fill0 == F` edge reversed, welded end-to-start into closed loops, painted
  with the **even-odd** rule.
- Strokes are painted after all fills, round cap / round join, never thinner
  than one screen pixel.

## Reserved for future versions

- fill `type` 1–255: gradients, bitmap fills
- non-edge flag 16 (NewStyles), for multi-layer documents
- `version` byte: layers, frames, named symbols
