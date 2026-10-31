"""Unit checks of the VSIX url rewriting. Run in the gallery image, see e2e/run.sh."""
import json, os, tempfile, zipfile
os.environ['URLROOT'] = 'https://vscode-offline.company.org'
import vsc
import offline

failures = 0
def check(description, condition):
    global failures
    failures += not condition
    print(('  PASS ' if condition else '  FAIL ') + description)

def make(root, files, signed=True, target=''):
    version = os.path.join(root, '1.0.0', target); os.makedirs(version)
    with zipfile.ZipFile(os.path.join(version, offline.VSIX_PACKAGE), 'w', zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            z.writestr(name, content)
    open(os.path.join(version, offline.CODE_MANIFEST), 'w').write(files.get('extension/package.json', '{}'))
    open(os.path.join(version, offline.VSIX_SIGNATURE), 'w').write('sig')
    entry = {'version': '1.0.0', 'files': [{'assetType': offline.VSIX_PACKAGE}, {'assetType': offline.VSIX_SIGNATURE}], 'properties': None}
    if target: entry['targetPlatform'] = target
    meta = {'identity': 'a.b', 'versions': [entry]}
    for path in ('latest.json', '1.0.0/extension.json'):
        json.dump(meta, open(os.path.join(root, path), 'w'))
    return os.path.join(version, offline.VSIX_PACKAGE)

def read(vsix, name):
    with zipfile.ZipFile(vsix) as z: return z.read(name).decode()

with tempfile.TemporaryDirectory() as root:
    vsix = make(root, {
        'extension/package.json': '{"u":"https://update.code.visualstudio.com"}',
        'extension/dist/a.js': 'x="https://marketplace.visualstudio.com/_apis/public/gallery/${e}";y="https://update.code.visualstudio.com.evil.org/";z="http://update.code.visualstudio.com/p"',
        'extension/readme.md': 'https://marketplace.visualstudio.com/items',
        'extension/img.png': b'\x89PNG https://update.code.visualstudio.com \xff',
    }, target='linux-x64')
    check('changed extension reported', offline.rewrite_extension(root))
    js = read(vsix, 'extension/dist/a.js')
    check('js url replaced, path and template kept', 'https://vscode-offline.company.org/_apis/public/gallery/${e}' in js)
    check('http scheme replaced', 'z="https://vscode-offline.company.org/p"' in js)
    check('lookalike host untouched', 'https://update.code.visualstudio.com.evil.org/' in js)
    check('package.json replaced', 'vscode-offline.company.org' in read(vsix, 'extension/package.json'))
    check('readme untouched', 'marketplace.visualstudio.com' in read(vsix, 'extension/readme.md'))
    with zipfile.ZipFile(vsix) as z:
        check('binary untouched', z.read('extension/img.png') == b'\x89PNG https://update.code.visualstudio.com \xff')
        check('zip is valid and compressed', z.testzip() is None and z.getinfo('extension/dist/a.js').compress_type == zipfile.ZIP_DEFLATED)
    version = os.path.dirname(vsix)
    check('manifest asset replaced', 'vscode-offline.company.org' in open(os.path.join(version, offline.CODE_MANIFEST)).read())
    check('signature file removed', not os.path.exists(os.path.join(version, offline.VSIX_SIGNATURE)))
    for path in ('latest.json', '1.0.0/extension.json'):
        entry = json.load(open(os.path.join(root, path)))['versions'][0]
        check(f'{path}: signature asset gone, marked private', all(f['assetType'] != offline.VSIX_SIGNATURE for f in entry['files']) and {'key': 'PrivateMarketplace', 'value': 'true'} in entry['properties'])
    check('second run changes nothing', not offline.rewrite_extension(root))

with tempfile.TemporaryDirectory() as root:
    vsix = make(root, {'extension/package.json': '{}', 'extension/readme.md': 'https://marketplace.visualstudio.com/items'})
    before = open(vsix, 'rb').read()
    check('nothing to replace: not reported', not offline.rewrite_extension(root))
    check('nothing to replace: VSIX byte identical', open(vsix, 'rb').read() == before)
    check('nothing to replace: signature kept', os.path.exists(os.path.join(root, '1.0.0', offline.VSIX_SIGNATURE)))
    check('nothing to replace: no temporary file', os.listdir(os.path.join(root, '1.0.0')).count(offline.VSIX_PACKAGE + '.rewrite') == 0)

with tempfile.TemporaryDirectory() as root:
    vsix = make(root, {'extension/package.json': '{"u":"https://update.code.visualstudio.com"}'})
    vsc.URLROOT = 'https://update.code.visualstudio.com'
    check('hijacked DNS mode (default URLROOT): no rewrite', not offline.rewrite_extension(root))

raise SystemExit(failures)
