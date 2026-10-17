# TinyCode

Tern 124M + reasoning + finetune on Python code tasks.

Two independent models: Code Generator (English request to Python) and
Code Narrator (Python to explanation). Inference runs on the visitor's CPU
in a Web Worker, with actual token streaming. No inference server or API key.

Site: https://mtchms.github.io/TinyCode/

## Model weights

- https://huggingface.co/large-language-leonid/tern-124M-code-generator
- https://huggingface.co/large-language-leonid/tern-124M-code-narrator

Each public repository must contain `model.onnx` at its root. Checksums in
web/public/*manifest.json pin the accepted weights. Weights are cached locally
after downloading. User requests and code are not sent to the model host.

## Build locally

Requires Node.js 22 and Python 3.10+; no Python dependencies for the build.

```sh
npm ci --prefix web
npm run build --prefix web
npm run build:generator --prefix web
python scripts/build_github_pages.py --source web --output site
python -m http.server 8080 --directory site
```

On localhost and HTTPS, the vendored coi-serviceworker adds isolation headers
for SharedArrayBuffer / WASM threads. It may reload the page on first visit.
The service worker is scoped to this project path, not other GitHub Pages sites.
If isolation is unavailable, inference uses one CPU thread.

## Deployment

The Pages workflow builds only the static site. No model weights, training
data, checkpoints, local reports or credentials are included in this repository.
The website loads approximately 650 MB of FP32 weights per mode, on demand.
This custom Tern model is not a Transformers AutoModel or hosted chat service.

## Third-party software

- ONNX Runtime Web 1.23.2: MIT, https://github.com/microsoft/onnxruntime
- Pyodide 0.28.3: MPL-2.0 and bundled components, https://github.com/pyodide/pyodide
- js-tiktoken 1.0.21: MIT, https://github.com/dqbd/tiktoken
- coi-serviceworker: MIT; vendored license in web/COI-LICENSE.txt
- Base model: https://huggingface.co/mikahniehaus/Tern

