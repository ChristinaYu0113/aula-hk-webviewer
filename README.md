# AULA & HK — Interactive 3D Building Viewer

Independent browser-based web viewer for the **AULA (TU Delft)** and **Herdenkingsmonument Kartuizerklooster (HK)** case studies. It shows sampled/processed SPC point clouds, HBIM-derived models, and segmented 3D Gaussian Splatting (S3DGS), with interactive patch inspection and cross-format links where verified.


## Viewer controls

- **Scene:** switch between **Monument** and **AULA · TU Delft**.
- **1 / 2 / 3:** SPC / HBIM / S3DGS. Orbit by dragging and zoom with the mouse wheel.
- **Q / W / E / R:** original colors / segmentation colors / material / structure (where attributes are available).
- Click surfaces or the patch list to inspect available attributes; use **Show only this patch** to isolate a segment.


## Data scope and caveats

| Case | SPC preview | HBIM preview | S3DGS preview |
| --- | --- | --- | --- |
| HK / Monument | 584,320 RGB points; 12 patches | IFC-derived geometry, 5 material groups | 12 segmented splat patches, 1,332,333 Gaussians |
| AULA | 1,349,997 sampled RGB points, 42 labeled patches plus unclassified points | Colored AULA/library mesh, 14 material groups | 85 numbered patches, 2,100,002 sampled Gaussians |

These are optimized browser-preview assets. In particular, AULA uses the original Unity project's approximate registration; only reviewed correspondences should be treated as confirmed. See the packaged viewer interface and model metadata for further detail.

## Project structure

```text
index.html                 Entry point for GitHub Pages
style.css                  Styles
viewer.js                  Compiled browser viewer
models/aula/               AULA manifests, point cloud, HBIM geometry, splats
models/monument/           HK manifests, point cloud, HBIM geometry, splats
src/                       Editable JavaScript source
scripts/build.mjs          Build script
scripts/prepare-models.py  Optional asset-preparation script; requires original source data
package.json               Build dependencies
server.mjs                 Local HTTP server (optional)
third-party-licenses.txt   Included browser dependency licenses
.nojekyll                  Bypass Jekyll processing on GitHub Pages
```

## Run locally / develop

Open in Chrome or Edge through an HTTP server (not with the `file://` protocol).

```bash
# Python is sufficient to serve the already-built viewer:
python -m http.server 8000
# Open http://localhost:8000/
```

To rebuild `viewer.js`, install Node.js 20+ and run:

```bash
npm ci
npm run build
npm start
# Open http://127.0.0.1:3070/
```

The `npm run prepare:assets` script depends on the original Unity files and point-cloud/splat source data; these raw inputs are not included in this repository. The preprocessed `models/` folder is already sufficient for the published viewer.

## Third-party software

Uses Three.js and Spark. License texts are included in `third-party-licenses.txt`.
