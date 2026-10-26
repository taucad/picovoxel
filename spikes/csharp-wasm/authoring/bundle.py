"""Stage reference assemblies and unchanged source beside a published W0 bundle."""
from pathlib import Path
import json
import shutil
import sys

app, sdk = map(Path, sys.argv[1:])
bundle = app / 'bin/Release/net11.0/publish/wwwroot'
refs = bundle / 'authoring/refs'
refs.mkdir(parents=True, exist_ok=True)
refpack = sorted((sdk / 'packs/Microsoft.NETCore.App.Ref').glob('11.*/ref/net11.0'))[-1]
for source in refpack.glob('*.dll'):
    shutil.copy2(source, refs / source.name)
for name in ('gyroid.dll', 'SkiaSharp.dll'):
    shutil.copy2(app / 'bin/Release/net11.0' / name, refs / name)
manifest = {'references': [{'url': f'authoring/refs/{p.name}', 'path': f'/refs/{p.name}'} for p in sorted(refs.glob('*.dll'))]}
for program, source_files in [('gyroid', [app / 'examples/Ex_ImplicitGyroidSphere.cs']), ('gyroid-sdf', [app / 'examples/Ex_ImplicitGyroidSphere.cs', app / 'shapekernel/Utilities/ImplicitUtility.cs']), ('heatx', sorted((app / 'examples/heatx').rglob('*.cs')))]:
    manifest[program] = []
    for i, source in enumerate(source_files):
        name = f'{i}-{source.name}'
        target = bundle / 'authoring' / program / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        manifest[program].append({'url': f'authoring/{program}/{name}', 'path': f'/source/{name}'})
(bundle / 'authoring.json').write_text(json.dumps(manifest, indent=2)+'\n')
shutil.copy2(app / 'index.html', bundle / 'index.html')
print(bundle)
