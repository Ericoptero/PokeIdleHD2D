# Blind comparison — packet `cave-golden`

Two screenshots, `A.png` and `B.png`, both 794x446. One is from a shipped
commercial Pokemon-style game, the other from a game in development. **You are not told which
is which, and you must not guess based on anything but how the images look.**

Which handles low-angle warm light more convincingly?

Look at both images. Then answer, as JSON written to `verdict.json` in this folder:

```json
{
  "better": "A" | "B",
  "confidence": 0.0-1.0,
  "why": "two or three sentences on what actually decided it",
  "weaknesses": { "A": ["..."], "B": ["..."] },
  "tell": "if one image looks unfinished or engine-like rather than art-directed, say which and why — otherwise null"
}
```

Judge on: readability of the scene, lighting and shadow believability, colour and contrast,
material and texture quality, composition and depth, and whether the image looks like a
finished game or like a test scene. Do not reward an image for being sharper or larger —
they are the same size. Be blunt; an honest loss is worth more than a polite tie.
