# Architecture studies

## Published paths

```text
/architectures/           Analysis index, rendered with the current Hugo theme
/ffmpeg/index.html        Korean FFmpeg report
/ffmpeg/en.html           English FFmpeg report
/ffmpeg/images/*.svg      Diagrams for both languages
```

Hugo copies `static/ffmpeg/` to `/ffmpeg/` without processing the report HTML.
The existing GitHub Actions workflow already publishes the generated `public/` directory.
Keep its current publishing configuration; no `/docs` publishing source is needed.

## Add another analysis

1. Put its static HTML in `static/<project>/index.html` and its SVGs in `static/<project>/images/`.
2. Add an entry to `data/architectures.yaml`, using FFmpeg as the example.
3. Run `hugo` and check `/architectures/`, both language links, and SVG downloads.

Use relative paths such as `images/diagram.svg` in reports. For a link back to the index,
use `../architectures/`. English reports can sit alongside Korean reports as `en.html`.
Each index entry needs only `title`, `description`, and `url`.
The report itself provides its Korean/English language switch.

## Local preview

```sh
hugo server --bind 0.0.0.0 --baseURL http://localhost:8001/ --port 8001
```

Publishing requires pushing to the deployment branch. Local edits and local previews do not publish the site.
