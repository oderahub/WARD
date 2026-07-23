# Dashboard brand assets

SVG sources for the social/icon PNGs in `dashboard/public/`. Regenerate with any
SVG rasterizer, e.g.:

```bash
# 1200x630 social card  ->  public/og.png
resvg design/og.svg public/og.png --width 1200
# 180x180 iOS icon      ->  public/apple-touch-icon.png
resvg design/apple-touch-icon.svg public/apple-touch-icon.png --width 180
```

Both use the same hexagonal gate mark as the in-app `Logo` component and
`public/favicon.svg`.
