"""
Additions for running the gallery behind a custom url (see product.json patching in the client extension):
custom VSIX uploads, artifact bundle imports, extra gallery endpoints and the JSON API used by the web frontend.
"""
import datetime
import glob
import json
import mimetypes
import os
import re
import shutil
import tarfile
import tempfile
import threading
import uuid
import zipfile
import logging as log
from distutils.version import LooseVersion
from urllib.parse import unquote

import falcon
from defusedxml import ElementTree

import vsc

FRONTEND_DIR = os.environ.get('FRONTEND_DIR', '/opt/vscoffline/vscgallery/frontend')
FRONTEND_INDEX = os.path.join(FRONTEND_DIR, 'index.html')
CLIENT_DIR = os.environ.get('CLIENT_DIR', '/opt/vscoffline/vscgallery/client')

MAX_VSIX_SIZE = int(os.environ.get('MAX_VSIX_SIZE', 512 * 1024 * 1024))
MAX_ASSET_SIZE = 64 * 1024 * 1024
CHUNK = 1024 * 1024

VSIX_NS = {'v': 'http://schemas.microsoft.com/developer/vsx-schema/2011'}
VSIX_PACKAGE = 'Microsoft.VisualStudio.Services.VSIXPackage'
VSIX_MANIFEST = 'Microsoft.VisualStudio.Services.VsixManifest'
TARGET_PLATFORMS = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'linux-armhf', 'alpine-x64',
                    'alpine-arm64', 'darwin-x64', 'darwin-arm64', 'web']
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]*$')
VERSION_RE = re.compile(r'^[0-9A-Za-z][0-9A-Za-z.+-]*$')
ASSET_RE = re.compile(r'^[A-Za-z0-9.]+$')

# Serialises all writes to the artifact directory
LOCK = threading.Lock()


def now_json():
    return datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.%fZ')


def find_extension_dir(identity):
    """Case-insensitive lookup of an extension folder, as the marketplace treats identities case-insensitively"""
    for folder in vsc.Utility.folders_in_folder(vsc.ARTIFACTS_EXTENSIONS):
        if folder.lower() == identity.lower():
            return os.path.join(vsc.ARTIFACTS_EXTENSIONS, folder)
    return None


def latest_version(extension):
    return extension['versions'][0]['version'] if extension and extension.get('versions') else None


def relative_url(url):
    """Strips URLROOT from asset urls so the web frontend works no matter how it was reached"""
    return url[len(vsc.URLROOT):] if url and url.startswith(vsc.URLROOT) else url


def write_stream(stream, destination, limit=None):
    size = 0
    with open(destination, 'wb') as f:
        while True:
            chunk = stream.read(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if limit and size > limit:
                raise falcon.HTTPPayloadTooLarge(description=f'Upload exceeds {limit} bytes')
            f.write(chunk)
    return size


class VSIXIngester(object):
    """
    Stores a user supplied VSIX in the same layout the sync produces, so the gallery serves it like any other extension
    """

    def ingest(self, vsixpath):
        try:
            with zipfile.ZipFile(vsixpath) as vsix:
                manifest_raw = self._read(vsix, 'extension.vsixmanifest')
                manifest = ElementTree.fromstring(manifest_raw)
                metadata = manifest.find('v:Metadata', VSIX_NS)
                identity_node = metadata.find('v:Identity', VSIX_NS) if metadata is not None else None
                if identity_node is None:
                    raise falcon.HTTPBadRequest(description='extension.vsixmanifest has no Identity')

                publisher = identity_node.get('Publisher', '')
                name = identity_node.get('Id', '')
                version = identity_node.get('Version', '')
                target = identity_node.get('TargetPlatform')
                if not NAME_RE.match(publisher) or not NAME_RE.match(name):
                    raise falcon.HTTPBadRequest(description=f'Invalid extension identity {publisher}.{name}')
                if not VERSION_RE.match(version) or '..' in version:
                    raise falcon.HTTPBadRequest(description=f'Invalid version {version}')
                if target and target not in TARGET_PLATFORMS:
                    raise falcon.HTTPBadRequest(description=f'Unsupported target platform {target}')
                identity = f'{publisher}.{name}'

                assets = {}
                for asset in manifest.findall('v:Assets/v:Asset', VSIX_NS):
                    assettype, path = asset.get('Type', ''), asset.get('Path', '')
                    if ASSET_RE.match(assettype) and assettype != VSIX_PACKAGE:
                        assets[assettype] = self._read(vsix, path)
                assets[VSIX_MANIFEST] = manifest_raw

                # VS Code refuses to install when package.json disagrees with the gallery metadata
                package = json.loads(assets.get('Microsoft.VisualStudio.Code.Manifest', b'{}'))
                packageidentity = (package.get('publisher'), package.get('name'), package.get('version'))
                if packageidentity != (publisher, name, version):
                    raise falcon.HTTPBadRequest(
                        description=f'package.json {packageidentity} does not match extension.vsixmanifest {(publisher, name, version)}')
        except zipfile.BadZipFile:
            raise falcon.HTTPBadRequest(description='Not a valid VSIX (zip) file')
        except ElementTree.ParseError as err:
            raise falcon.HTTPBadRequest(description=f'Invalid extension.vsixmanifest: {err}')
        except ValueError as err:
            raise falcon.HTTPBadRequest(description=f'Invalid package.json: {err}')

        def text(tag):
            node = metadata.find(f'v:{tag}', VSIX_NS)
            return node.text.strip() if node is not None and node.text else ''

        def split(tag):
            return [item for item in text(tag).split(',') if item]

        properties = [{'key': prop.get('Id'), 'value': prop.get('Value')}
                      for prop in metadata.findall('v:Properties/v:Property', VSIX_NS)]
        # Uploads carry no marketplace signature. VS Code only requires one for public extensions
        properties.append({'key': 'PrivateMarketplace', 'value': 'true'})

        with LOCK:
            extensiondir = find_extension_dir(identity) or os.path.join(vsc.ARTIFACTS_EXTENSIONS, identity)
            existing = vsc.Utility.load_json(os.path.join(extensiondir, 'latest.json'))
            if existing and not existing.get('uploaded'):
                raise falcon.HTTPConflict(
                    description=f'{identity} is mirrored from the official marketplace and cannot be replaced by an upload')
            current = latest_version(existing)
            if current and LooseVersion(version) < LooseVersion(current):
                raise falcon.HTTPConflict(description=f'{identity} already has newer version {current}')

            versiondir = os.path.join(extensiondir, version, target or '')
            shutil.rmtree(versiondir, ignore_errors=True)
            os.makedirs(versiondir)
            for assettype, content in assets.items():
                with open(os.path.join(versiondir, assettype), 'wb') as f:
                    f.write(content)
            shutil.move(vsixpath, os.path.join(versiondir, VSIX_PACKAGE))

            timestamp = now_json()
            entry = {
                'version': version,
                'flags': 'validated',
                'lastUpdated': timestamp,
                'files': [{'assetType': assettype, 'source': ''} for assettype in [VSIX_PACKAGE, *assets]],
                'properties': properties,
                'assetUri': '',
                'fallbackAssetUri': '',
            }
            if target:
                entry['targetPlatform'] = target

            versions = [entry]
            if current == version:
                # Another target platform of the same version
                versions += [v for v in existing['versions'] if v.get('targetPlatform') != target]

            existing = existing or {}
            extension = {
                'identity': identity,
                'extensionId': existing.get('extensionId', str(uuid.uuid4())),
                'extensionName': name,
                'displayName': text('DisplayName') or name,
                'shortDescription': text('Description'),
                'flags': 'validated, public',
                'lastUpdated': timestamp,
                'publishedDate': existing.get('publishedDate', timestamp),
                'releaseDate': existing.get('releaseDate', timestamp),
                'publisher': existing.get('publisher', {
                    'publisherId': str(uuid.uuid4()),
                    'publisherName': publisher,
                    'displayName': publisher,
                    'flags': 'none',
                }),
                'versions': versions,
                'categories': split('Categories'),
                'tags': split('Tags'),
                'statistics': [],
                'installationTargets': [{'target': 'Microsoft.VisualStudio.Code', 'targetVersion': ''}],
                'deploymentType': 0,
                'recommended': False,
                'uploaded': True,
            }
            vsc.Utility.write_json(os.path.join(extensiondir, 'latest.json'), extension)
            vsc.Utility.write_json(os.path.join(extensiondir, version, 'extension.json'), extension)
            vsc.Utility.prune_extension_versions(extensiondir)

        log.info(f'Stored uploaded extension {identity} {version} {target or ""}')
        return {'identity': identity, 'version': version, 'targetPlatform': target}

    def _read(self, vsix, path):
        for candidate in (path, unquote(path)):
            try:
                info = vsix.getinfo(candidate)
            except KeyError:
                continue
            if info.file_size > MAX_ASSET_SIZE:
                raise falcon.HTTPBadRequest(description=f'{path} in VSIX is too large')
            return vsix.read(info)
        raise falcon.HTTPBadRequest(description=f'{path} is missing from the VSIX')


class BundleImporter(object):
    """
    Soaks up a tar of an artifact directory produced by the sync (e.g. `tar -cf bundle.tar -C artifacts .`).
    Newer extension versions replace older ones, which are then deleted. Installers are merged.
    """
    TOP_FILES = ('malicious.json', 'recommendations.json')

    def import_stream(self, stream):
        staging = tempfile.mkdtemp(prefix='.import-', dir=vsc.ARTIFACTS)
        try:
            with tarfile.open(fileobj=stream, mode='r|*') as tar:
                for member in tar:
                    name = self._normalise(member.name)
                    if not name or not (member.isfile() or member.isdir()):
                        continue
                    member.name = name
                    tar.extract(member, staging, filter='data')
            with LOCK:
                return {
                    'extensions': self._merge_extensions(os.path.join(staging, 'extensions')),
                    'installers': self._merge_installers(os.path.join(staging, 'installers')),
                    'files': self._merge_top_files(staging),
                }
        except tarfile.TarError as err:
            raise falcon.HTTPBadRequest(description=f'Invalid tar: {err}')
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def _normalise(self, name):
        parts = [part for part in name.split('/') if part not in ('', '.')]
        if parts and parts[0] == 'artifacts':
            parts = parts[1:]
        if not parts or '..' in parts or name.startswith('/'):
            return None
        if parts[0] in ('extensions', 'installers') or (len(parts) == 1 and parts[0] in self.TOP_FILES):
            return '/'.join(parts)
        return None

    def _merge_extensions(self, source):
        imported, skipped = [], []
        if not os.path.isdir(source):
            return {'imported': imported, 'skipped': skipped}
        for folder in vsc.Utility.folders_in_folder(source):
            src = os.path.join(source, folder)
            incoming = vsc.Utility.load_json(os.path.join(src, 'latest.json'))
            if not latest_version(incoming):
                skipped.append(folder)
                continue
            dst = find_extension_dir(folder) or os.path.join(vsc.ARTIFACTS_EXTENSIONS, folder)
            current = latest_version(vsc.Utility.load_json(os.path.join(dst, 'latest.json')))
            if current and LooseVersion(current) > LooseVersion(latest_version(incoming)):
                log.info(f'Import skips {folder} {latest_version(incoming)}, {current} is newer')
                skipped.append(folder)
                continue
            os.makedirs(dst, exist_ok=True)
            for version in vsc.Utility.folders_in_folder(src):
                shutil.rmtree(os.path.join(dst, version), ignore_errors=True)
                shutil.move(os.path.join(src, version), os.path.join(dst, version))
            os.replace(os.path.join(src, 'latest.json'), os.path.join(dst, 'latest.json'))
            vsc.Utility.prune_extension_versions(dst)
            imported.append(f'{folder}@{latest_version(incoming)}')
        log.info(f'Imported {len(imported)} extensions, skipped {len(skipped)}')
        return {'imported': imported, 'skipped': skipped}

    def _merge_installers(self, source):
        count = 0
        for root, _, files in os.walk(source):
            target = os.path.join(vsc.ARTIFACTS_INSTALLERS, os.path.relpath(root, source))
            os.makedirs(target, exist_ok=True)
            for file in files:
                os.replace(os.path.join(root, file), os.path.join(target, file))
                count += 1
        return count

    def _merge_top_files(self, source):
        merged = []
        for file in self.TOP_FILES:
            if os.path.isfile(os.path.join(source, file)):
                os.replace(os.path.join(source, file), os.path.join(vsc.ARTIFACTS, file))
                merged.append(file)
        return merged


class APIUploadVSIX(object):

    def __init__(self, gallery):
        self.gallery = gallery

    def on_post(self, req, resp):
        fd, tmppath = tempfile.mkstemp(prefix='.upload-', suffix='.vsix', dir=vsc.ARTIFACTS)
        os.close(fd)
        try:
            write_stream(req.bounded_stream, tmppath, MAX_VSIX_SIZE)
            resp.media = VSIXIngester().ingest(tmppath)
        finally:
            if os.path.exists(tmppath):
                os.remove(tmppath)
        self.gallery.update_state()
        resp.status = falcon.HTTP_201


class APIImportBundle(object):

    def __init__(self, gallery):
        self.gallery = gallery

    def on_post(self, req, resp):
        resp.media = BundleImporter().import_stream(req.bounded_stream)
        self.gallery.update_state()
        resp.status = falcon.HTTP_200


class APIExtensions(object):

    def __init__(self, gallery):
        self.gallery = gallery

    def on_get(self, req, resp):
        resp.media = [self.summary(ext) for ext in self.gallery.extensions.values()]

    @staticmethod
    def summary(ext):
        latest = ext['versions'][0]
        properties = {prop['key']: prop['value'] for prop in latest.get('properties') or []}
        assets = {f['assetType']: relative_url(f['source']) for f in latest.get('files', [])}
        return {
            'identity': ext['identity'],
            'displayName': ext.get('displayName') or ext['identity'],
            'publisher': ext['publisher'].get('displayName') or ext['publisher']['publisherName'],
            'shortDescription': ext.get('shortDescription', ''),
            'version': latest['version'],
            'lastUpdated': ext.get('lastUpdated'),
            'installs': ext.get('stats', {}).get('install', 0),
            'categories': ext.get('categories', []),
            'uploaded': bool(ext.get('uploaded')),
            'engine': properties.get('Microsoft.VisualStudio.Code.Engine'),
            'dependencies': [d for d in properties.get('Microsoft.VisualStudio.Code.ExtensionDependencies', '').split(',') if d],
            'icon': assets.get('Microsoft.VisualStudio.Services.Icons.Default'),
            'readme': assets.get('Microsoft.VisualStudio.Services.Content.Details'),
            'changelog': assets.get('Microsoft.VisualStudio.Services.Content.Changelog'),
            'downloads': [{
                'version': version['version'],
                'targetPlatform': version.get('targetPlatform', 'universal'),
                'url': relative_url(version['assetUri']) + '/' + VSIX_PACKAGE,
            } for version in ext['versions']],
        }


class APIInstallers(object):

    def on_get(self, req, resp):
        result = []
        for latestpath in sorted(glob.glob(os.path.join(vsc.ARTIFACTS_INSTALLERS, '*', '*', 'latest.json'))):
            latest = vsc.Utility.load_json(latestpath)
            if not latest:
                continue
            updatedir = os.path.dirname(latestpath)
            payload = vsc.Utility.first_file(updatedir, f"vscode-{latest['name']}.*")
            result.append({
                'identity': os.path.basename(os.path.dirname(updatedir)),
                'quality': os.path.basename(updatedir),
                'name': latest['name'],
                'productVersion': latest.get('productVersion'),
                'commit': latest.get('version'),
                'timestamp': latest.get('timestamp'),
                'url': payload if payload else None,
            })
        client = vsc.Utility.first_file(CLIENT_DIR, '*.vsix') if os.path.isdir(CLIENT_DIR) else False
        resp.media = {
            'installers': result,
            'client': '/client/' + os.path.basename(client) if client else None,
        }


class APIHealth(object):

    def __init__(self, gallery):
        self.gallery = gallery

    def on_get(self, req, resp):
        resp.media = {'status': 'ok', 'url': vsc.URLROOT, 'extensions': len(self.gallery.extensions)}


class VSCGalleryLatest(object):
    """
    Implements product.json extensionsGallery.extensionUrlTemplate ({url}/_gallery/{publisher}/{name}/latest)
    """

    def __init__(self, gallery):
        self.gallery = gallery

    def on_get(self, req, resp, publisher, name):
        identity = f'{publisher}.{name}'.lower()
        for key, ext in self.gallery.extensions.copy().items():
            if key.lower() == identity:
                resp.media = ext
                return
        resp.status = falcon.HTTP_404


class VSCResource(object):
    """
    Implements product.json extensionsGallery.resourceUrlTemplate by reading files straight out of the stored VSIX
    """

    def on_get(self, req, resp, publisher, name, version, path):
        extensiondir = find_extension_dir(f'{publisher}.{name}')
        if not extensiondir or not VERSION_RE.match(version) or '..' in version:
            raise falcon.HTTPNotFound()
        vsixes = glob.glob(os.path.join(extensiondir, version, VSIX_PACKAGE)) + \
            glob.glob(os.path.join(extensiondir, version, '*', VSIX_PACKAGE))
        if not vsixes:
            raise falcon.HTTPNotFound()
        with zipfile.ZipFile(vsixes[0]) as vsix:
            try:
                info = vsix.getinfo('extension/' + path)
            except KeyError:
                raise falcon.HTTPNotFound()
            if info.file_size > MAX_ASSET_SIZE:
                raise falcon.HTTPNotFound()
            resp.data = vsix.read(info)
        resp.content_type = mimetypes.guess_type(path)[0] or 'application/octet-stream'


class FrontendIndex(object):

    def on_get(self, req, resp, **params):
        resp.content_type = 'text/html'
        with open(FRONTEND_INDEX, 'r') as f:
            resp.text = f.read()


def add_routes(application, gallery):
    application.add_route('/api/health', APIHealth(gallery))
    application.add_route('/api/extensions', APIExtensions(gallery))
    application.add_route('/api/installers', APIInstallers())
    application.add_route('/api/upload/vsix', APIUploadVSIX(gallery))
    application.add_route('/api/import', APIImportBundle(gallery))
    application.add_route('/_gallery/{publisher}/{name}/latest', VSCGalleryLatest(gallery))
    application.add_route('/resources/{publisher}/{name}/{version}/{path:path}', VSCResource())
    if os.path.isdir(CLIENT_DIR):
        application.add_static_route('/client/', CLIENT_DIR)
    if os.path.exists(FRONTEND_INDEX):
        index = FrontendIndex()
        # Single page app routes, including product.json itemUrl/publisherUrl/downloadUrl
        for route in ('/', '/items', '/publishers', '/publishers/{publisher}', '/downloads', '/upload'):
            application.add_route(route, index)
        application.add_static_route('/assets/', os.path.join(FRONTEND_DIR, 'assets'))
