# DimRead icon exploration — research, prompt templates, concepts

The shipped mark is **code**, not a raster export (`tools/assets/dimread_mark.py`). This
file is the exploration layer in front of that: the competitive read that decides *what*
to draw, and the prompt templates for generating exploration boards when a new direction
is needed.

Reference sheet: `competitor-marks.png` — 10 shipping marks in this category, each at
128 px and at 16 px on a dark taskbar strip.

---

## 1. What the category actually looks like

Marks examined: f.lux, Iris, Twinkle Tray, LightBulb, Lunar, DisplayBuddy, Monitorian,
CareUEyes, Dark Reader, SunsetScreen.

**The silhouette is a circle.** f.lux (sun over a horizon), Iris (aperture ring), CareUEyes
(eye), Lunar (moon), SunsetScreen (crescent in a warm/cool swirl) — five of ten. Only
DisplayBuddy ships the gradient-squircle-with-a-small-glyph-inside pattern, and it is the
least legible mark in the set at tray size.

**What survives 16 px:**

| mark | why it survives |
|---|---|
| Monitorian | fat monochrome shapes, white-on-black, zero interior detail |
| Iris | one thick ring; the hole is as big as the stroke |
| CareUEyes | one strong closed silhouette (an eye) |
| f.lux | a two-tone disc — colour does the work, not shape |

**What dies at 16 px:**

| mark | failure |
|---|---|
| Twinkle Tray | thin radiating star points → grey mush |
| Dark Reader | a mascot; faces need pixels |
| LightBulb | outline strokes + interior split; the stroke vanishes first |
| DisplayBuddy | glyph nested inside a bezel inside a tile → three nested edges, no ink left |

**The open lane.** f.lux and SunsetScreen both gesture at a warm/cool colour-temperature
disc and both do it with soft gradients that go muddy when downscaled. **Nobody owns a
crisp, hard-edged two-tone temperature disc** — which is DimRead's product in one shape,
since a Kelvin slider *is* cool-at-one-end, warm-at-the-other.

**Rules this yields, in priority order:**

1. One closed silhouette. Not a glyph inside a container inside a tile.
2. Colour carries state; shape carries identity. Colour survives downscaling; 2 px details
   do not.
3. Nothing thinner than ~1/7 of the mark's width.
4. Give the differentiating element the majority of the area, not a corner of it.
5. No outline-only treatments, no gradients that need more than two stops.
6. **Separate glyphs by topology, not by proportion.** This is the rule the rebuild kept
   re-learning. Eight glyphs inside a 9 px circle is close to the packing limit, and
   resizing a shape never buys separation — changing its *structure* does. Every collision
   measured at 16 px was two glyphs sharing a topology: an open book beside a gutter is
   "two vertical masses with a vertical gap", which is `pause`; a page, a block and a
   briefcase body are all "one rectangular mass"; a play triangle and a short fat pencil
   wedge are both "one triangular mass". The fixes were all topological — a detached
   handle (`office`), a bottom notch (`reading`), an uneven skyline over a flat base
   (`custom`), a long tapered diagonal (`editing`).

---

## 2. Prompt templates

Distilled from current gpt-image / DALL·E-in-ChatGPT prompting guidance
([IconikAI](https://www.iconikai.com/blog/app-icon-prompts-ai-2026),
[buldrr](https://buldrr.com/the-ultimate-chatgpt-image-model-1-5-guide-to-prompting/),
[AI Academy](https://academy.techpresso.co/prompts/chatgpt-prompts-icon-design)).

### The five-clause skeleton

```
{subject} + {style} + {colour palette} + {background} + {format constraints}
```

Order matters: these models weight the head of the prompt most heavily, so the subject
leads and the format specs trail. The techniques that actually change the output:

* **One subject.** "lotus and mountain and sun" produces clutter. One noun phrase.
* **One style anchor.** Pick exactly one of flat / 3D / isometric / line art. Two style
  words contradict each other and the model averages them into slop.
* **State the background explicitly** ("flat light-neutral background", "transparent
  background") or the model invents a scene behind the icon.
* **Close with the format clause.** `app icon, 1024x1024, no text` — the literal phrase
  "app icon" locks the square framing, and "no text" is required because text in a
  generated icon comes out as broken letterforms nearly every time.
* **Negatives are cheap and effective.** `no text, no watermark, no mockup, no gradient
  mesh, no drop shadow, no outline strokes, no thin details`.
* **For a SET, the consistency clause does the work:** *"all variants share identical
  silhouette, stroke weight and corner radius; only the interior glyph changes."* Repeat it
  verbatim on every prompt in the batch. Batch 6–8 variants per generation, not 32.
* **Ask for the small size in the same image.** Generation guides converge on "if it is
  invisible, simplify" — so make the board prove it: request the mark repeated at large
  size and at tray size in one canvas.

### DimRead board template

```
Generate a 1:1 square icon exploration board on a flat light-neutral background.
Subject: {CONCEPT}.
Style: flat hard-edged vector, one closed silhouette, no outline strokes, no interior detail.
Colours: deep indigo #2B336E and blue-violet #6C7CFF for the identity element; pale cool
blue #BAD0FF and warm amber #FAB04E for the light element. Two flat stops only, no gradient mesh.
Layout: the mark once at large size, then the same mark repeated small three times — as a
white silhouette on a dark strip, as a dark silhouette on a light strip, and at 16 px scale.
Every element at least 1/7 of the mark's width thick; nothing thinner.
No text, no watermark, no mockup, no drop shadow, no 3D, no glossy highlight.
app icon, 1024x1024, no text.
```

### Mode-variant batch template

```
Generate one 1:1 sheet of 8 variants of a single icon on a flat light-neutral background.
Base mark: {THE CHOSEN MARK, described in one sentence}.
The interior glyph changes per variant, in a 4x2 grid, in this order: two vertical bars;
a heart; a d-pad cross; a play triangle; a briefcase with a detached handle; a pencil at 45
degrees; a bookmark notched at the bottom; three equalizer bars at different heights.
All eight variants share identical silhouette, size, colour and edge weight — ONLY the
interior glyph differs. Each glyph is knocked out of the mark as transparent negative
space, filling about 64% of its width, with no element thinner than 1/7 of that width.
Flat hard-edged vector. No text, no watermark, no outline strokes, no 3D, no shadow.
app icon, 1024x1024, no text.
```

---

## 3. Concepts, ranked

Each is one closed silhouette with a two-stop palette and room for a knocked-out glyph.

1. **Temperature Disc — SHIPPED.** One circle split through the centre; the cool half is
   brand indigo (identity), the warm half is the light DimRead is currently emitting (pale
   cool on the day profile, amber on the night one), and the mode glyph is knocked out of
   the whole disc. Wins because state becomes ~50 % of the icon instead of a 4-pixel stripe,
   the glyph gets the full diameter, and the crisp two-tone disc is the one shape the
   category has left on the table. (A disc covers slightly *less* of the cell than a rounded
   square — the win is not raw ink, it is that the entire interior is available to the glyph
   and the silhouette stops being "a blue box".) Substitute for `{CONCEPT}`: *a solid circle split through
   the centre into a cool indigo half and a warm amber half, with a simple geometric glyph
   knocked out of the middle as transparent negative space*.
2. **Half-Lit Disc.** Same circle, but the warm region is a crescent rather than a half —
   the disc "lit from one side". More organic; risks reading as a moon phase (Lunar owns
   that) and gives less state area.
3. **Kelvin Bar.** A single thick horizontal capsule running cool → warm, glyph knocked out
   of the centre. The most literal statement of the product. Rejected as the primary: a
   wide capsule wastes half of a square tray cell.
4. **Aperture Wedges.** Three or four fat wedges around a hub, warm on one side. Distinct
   and dynamic; too close to Iris, and the hub eats the glyph's area.
5. **Dusk Window.** A rounded window whose upper edge descends from cool to warm.
   This is the previous direction — it is the DisplayBuddy pattern and it lost at 16 px.
6. **Comfort Canopy.** A bell-like contour reading as both a reading lamp and an open page.
   Attractive at 512 px, ambiguous at 16.
