"""Build a static site; large model weights are fetched from public Hugging Face."""
import argparse
import json
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=Path('browser_demo'))
parser.add_argument('--output', type=Path, default=Path('exports/github-pages/site'))
args = parser.parse_args()
source, output = args.source.resolve(), args.output.resolve()
assert source != output and not source.is_relative_to(output)
output.mkdir(parents=True, exist_ok=True)
def copy(relative):
    dest = output / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / relative, dest)

for name in ('index.html', 'generator.html', 'narrator.html', 'style.css', 'app.js',
             'generator_app.js', 'worker.bundle.js', 'generator_worker.bundle.js',
             'coi-serviceworker.js', 'COI-LICENSE.txt', 'public/preprocess.py',
             'public/examples.json', 'public/generator/examples.json'):
    copy(name)
for name in ('index.html', 'generator.html', 'narrator.html'):
    path = output / name
    html = path.read_text(encoding='utf-8')
    html = html.replace('<link rel="stylesheet"', '<script src="./coi-serviceworker.js"></script><link rel="stylesheet"', 1)
    path.write_text(html, encoding='utf-8')
for relative, repo in [
    ('public/manifest.json', 'large-language-leonid/tern-124M-code-narrator'),
    ('public/generator/manifest.json', 'large-language-leonid/tern-124M-code-generator'),
]:
    manifest = json.loads((source / relative).read_text(encoding='utf-8'))
    manifest['model_url'] = f'https://huggingface.co/{repo}/resolve/main/model.onnx'
    dest = output / relative
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
for name in ('ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'):
    copy('node_modules/onnxruntime-web/dist/' + name)
for name in ('pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'):
    copy('node_modules/pyodide/' + name)
(output / '.nojekyll').write_text('', encoding='utf-8')
files = [p for p in output.rglob('*') if p.is_file()]
assert not any(p.suffix in {'.onnx', '.pt'} for p in files)
print(json.dumps(dict(output=str(output), files=len(files), bytes=sum(p.stat().st_size for p in files))))
