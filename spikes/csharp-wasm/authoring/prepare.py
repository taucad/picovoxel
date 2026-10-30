"""Prepare an independently publishable W0 app from build.sh's AOT baseline."""
from pathlib import Path
import shutil
import argparse
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('base', type=Path)
parser.add_argument('dest', type=Path)
parser.add_argument('--profiled-base', action='store_true')
parser.add_argument('--skia-version', default='3.119.0')
args = parser.parse_args()
base, dest = args.base, args.dest
here = Path(__file__).resolve().parent
if dest.exists():
    raise SystemExit(f"Refusing to replace {dest}; choose a fresh output directory")
dest.mkdir(parents=True)
for name in ('native', 'picogk', 'shapekernel', 'host', 'examples'):
    shutil.copytree(base / name, dest / name)
for name in ('gyroid.csproj', 'runtimeconfig.template.json', 'main.mjs'):
    shutil.copy2(base / name, dest / name)
shutil.copy2(here / 'Authoring.cs', dest / 'host/Authoring.cs')
project = ET.parse(dest / 'gyroid.csproj')
root = project.getroot()
for group in root.findall('ItemGroup'):
    for item in list(group):
        if not args.profiled_base and item.tag == 'Compile' and item.get('Include') == 'examples/**/*.cs':
            group.remove(item)
for package in root.iter('PackageReference'):
    if package.get('Include', '').startswith('SkiaSharp'):
        package.set('Version', args.skia_version)
props = ET.SubElement(root, 'PropertyGroup')
# Dynamic code needs preserved APIs and IL fallback for generic instantiations.
ET.SubElement(props, 'WasmStripILAfterAOT').text = 'false'
items = ET.SubElement(root, 'ItemGroup')
ET.SubElement(items, 'PackageReference', Include='Microsoft.CodeAnalysis.CSharp', Version='4.14.0')
if not args.profiled_base:
    ET.SubElement(items, 'TrimmerRootAssembly', Include='gyroid')
ET.SubElement(items, 'TrimmerRootAssembly', Include='System.Runtime')
ET.SubElement(items, 'TrimmerRootAssembly', Include='System.Collections')
ET.SubElement(items, 'TrimmerRootAssembly', Include='System.Numerics.Vectors')
ET.indent(project)
project.write(dest / 'gyroid.csproj', encoding='unicode')
p = dest / 'host/Program.cs'
s = p.read_text().replace('if (strProgram == "heatx") return nRunHeatX(oViewer, nRuns);', '''var authored = Authoring.Compile("/source");
        Action task = Authoring.Task(authored, strProgram == "heatx" ? "Leap71.CoolCube.HelixHeatX" : "Leap71.ShapeKernelExamples.ImplicitGyroidSphere");
        if (strProgram == "heatx") return nRunHeatX(oViewer, nRuns, task);''')
s = s.replace('Leap71.ShapeKernelExamples.ImplicitGyroidSphere.Task();', 'task();')
s = s.replace('static int nRunHeatX(Viewer oViewer, int nRuns)', 'static int nRunHeatX(Viewer oViewer, int nRuns, Action task)')
s = s.replace('Leap71.CoolCube.HelixHeatX.Task();', 'task();')
s = s.replace('var sdfGyroid = new Leap71.ShapeKernel.ImplicitGyroid(3, 1);', '''IImplicit sdfGyroid = authored.GetType("Leap71.ShapeKernel.ImplicitGyroid") is Type dynamicSdf
            ? (IImplicit)Activator.CreateInstance(dynamicSdf, 3f, 1f)
            : new Leap71.ShapeKernel.ImplicitGyroid(3, 1);''')
if args.profiled_base:
    s = s.replace('var authored = Authoring.Compile', '''// Retain the representative API call graph without executing its AOT tasks.
        if (Environment.GetEnvironmentVariable("W0_ROOT") == "1")
        {
            Leap71.ShapeKernelExamples.ImplicitGyroidSphere.Task();
            Leap71.CoolCube.HelixHeatX.Task();
        }
        var authored = Authoring.Compile''')
p.write_text(s)
shutil.copy2(here / 'index.html', dest / 'index.html')
print(dest)
