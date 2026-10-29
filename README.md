# The Image Tabulator

A browser app for sorting a folder of photos into named groups and seeing how the groups break down.

- Open a folder of photos from your computer (Microsoft Edge or Google Chrome).
- Click photos to select them, then **Add to group**. Keys 1–9 add the selection to a group.
- Hold the right mouse button on a photo to enlarge it.
- Folders with more than 300 photos are split into batches, with a grouped counter for the batch or the whole folder.
- **Statistics** shows group sizes and can export a CSV.

## Privacy

Photos never leave your computer. The app reads them directly in your browser; nothing is uploaded.
Groups are saved in your browser's local storage, so they stay on that browser and computer only.

## Running it

- **Locally:** open `index.html` in Edge or Chrome.
- **Hosted:** deployed on Render as a static site using `render.yaml` (no build step).
