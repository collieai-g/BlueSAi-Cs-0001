"""Generate reviewable native Blueprint assets; never install or restart a host."""
import argparse
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / 'integrations/blueprint/native'
SOURCE_ASSETS = ('agent-card.html', 'agent-card.css', 'workbench-api.js',
                 'agent-handoff.js', 'inbox-tools.js', 'workbench.js')
OUTPUT_ASSETS = ('agent-card.css', 'agent-handoff.js', 'inbox-tools.js',
                 'renderer.js', 'workbench-api.js', 'workbench.js')
GENERATOR = 'bluesai-blueprint-card/1'
VOID_TAGS = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
             'link', 'meta', 'param', 'source', 'track', 'wbr'}


def replace_once(source, old, new, label):
    if source.count(old) != 1:
        raise ValueError('Native transform requires review: ' + label)
    return source.replace(old, new, 1)


class ComponentParser(HTMLParser):
    """Compile a reviewed component to createElement data, never runtime HTML."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.roots = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        if tag in {'script', 'style', 'iframe', 'html', 'body', 'head'}:
            raise ValueError('Forbidden native component tag: ' + tag)
        if len(dict(attrs)) != len(attrs) or any(key.startswith('on') for key, _ in attrs):
            raise ValueError('Unsupported native component attributes')
        node = [tag, {key: value if value is not None else '' for key, value in attrs}, []]
        (self.stack[-1][2] if self.stack else self.roots).append(node)
        if tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1][0] != tag:
            raise ValueError('Unbalanced component markup: ' + tag)
        self.stack.pop()

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_data(self, data):
        if data.strip():
            if not self.stack:
                raise ValueError('Text outside the native component')
            self.stack[-1][2].append(data)


def component_tree(markup):
    parser = ComponentParser()
    parser.feed(markup)
    parser.close()
    if parser.stack or len(parser.roots) != 1 or parser.roots[0][1].get('id') != 'cs-card-design':
        raise ValueError('Expected exactly one balanced #cs-card-design component')
    return parser.roots[0]


def adapt_workbench(source):
    source = replace_once(source, '\n  (async()=>{', '\n  return await (async()=>{', 'workbench async entry')
    tweak = "    if(globalThis.Tweak){const tweak=new Tweak({container:find('.bp-agent-card'),onChange:()=>{render();remember();}});tweak.addToggle(state,'showNumber',{label:'顯示 Agent 編號'});tweak.addSlider(state,'cardPadding',{label:'卡片留白',min:18,max:30,step:2,unit:'px'});}"
    source = replace_once(source, tweak, '    return {isBusy:()=>busy,refresh:()=>refresh(false)};', 'design-only Tweak controls')
    return '''// Generated native-host adaptation; edit the canonical component, not this file.
export async function initializeWorkbench(componentRoot,scope) {
  const document=scope.document,window=scope.window;
  const setInterval=scope.setInterval,clearInterval=scope.clearInterval;
  const EventSource=undefined; // The host contract declares sse:false; active-card polling only.
  const Notification=scope.Notification;
  const setTimeout=scope.setTimeout,clearTimeout=scope.clearTimeout;
''' + source.rstrip() + '\n}\n'


def adapt_inbox(source):
    source = replace_once(source, "(() => {\n  const root = document.getElementById('cs-card-design');\n", 'export function initializeInboxTools(root,scope) {\n  const window=scope.window,document=scope.document;\n', 'inbox module entry')
    if not source.endswith('})();\n'):
        raise ValueError('Native transform requires review: inbox module end')
    return source[:-6] + '  return root.csInboxTools;\n}\n'


def adapt_handoff(source):
    if not source.startswith('(() => {\n') or not source.endswith('})();\n'):
        raise ValueError('Native transform requires review: handoff module boundaries')
    source = 'export function createAgentBridge(scope) {\n  const window=scope.window,document=scope.document;\n' + source[9:-6]
    source = replace_once(source, '  window.csAgentBridge = {', '  const bridge = {', 'handoff bridge export')
    return source + '  return bridge;\n}\n'


def adapt_backend(source, template):
    start = '  surface.csBackend={\n'
    end = "  };\n  document.querySelector('[data-local-login-form]')"
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError('Native transform requires review: backend method boundaries')
    prefix, tail = source.split(start, 1)
    methods, suffix = tail.split(end, 1)
    # Host identity/CSRF replaces the reviewed standalone transport. If that
    # transport changes upstream, review it instead of silently discarding it.
    if digest(prefix + start + end + suffix) != '5be6f8f8cdbc315f555dc0ee84bc56d17eab862f6f231dc90816d5c0cb544e1b':
        raise ValueError('Native transform requires review: standalone backend transport')
    methods = methods.rstrip('\n')
    methods = replace_once(methods, "    async load(){const result=await api('/state');surface.hidden=false;if(login)login.hidden=true;return result;},", "    async load(){const result=await api('/state');surface.hidden=false;return result;},", 'standalone login removal')
    return replace_once(template, '@@ENDPOINT_METHODS@@', methods, 'backend template methods')


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def build_assets(source_root, revision):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('--source-revision must be a full lowercase 40-character commit')
    # Refuse to propagate a hand-edited generated asset that the canonical build
    # would erase. The builder is imported without running its writing CLI.
    spec = importlib.util.spec_from_file_location('workbench_builder', ROOT / 'tools/build-workbench.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    builder.root = source_root
    expected = builder.build_assets(source_root / 'design/customer-agent-card-design.html')
    drift = [name for name, value in expected.items()
             if (source_root / 'public' / name).read_text(encoding='utf-8') != value]
    if drift:
        raise ValueError('Canonical generated UI drift: ' + ', '.join(drift))
    sources = {name: (source_root / 'public' / name).read_text(encoding='utf-8') for name in SOURCE_ASSETS}
    templates = {name: (TEMPLATES / name).read_text(encoding='utf-8')
                 for name in ('renderer.js.tmpl', 'backend.js.tmpl', 'host-bounds.css')}
    renderer = replace_once(templates['renderer.js.tmpl'], '@@SOURCE_REVISION@@', revision, 'renderer source pin')
    renderer = replace_once(renderer, '@@COMPONENT_TREE@@', json.dumps(component_tree(sources['agent-card.html']), ensure_ascii=False, separators=(',', ':')), 'renderer component tree')
    assets = {
        'agent-card.css': sources['agent-card.css'].rstrip() + '\n\n' + templates['host-bounds.css'],
        'agent-handoff.js': adapt_handoff(sources['agent-handoff.js']),
        'inbox-tools.js': adapt_inbox(sources['inbox-tools.js']),
        'renderer.js': renderer,
        'workbench-api.js': adapt_backend(sources['workbench-api.js'], templates['backend.js.tmpl']),
        'workbench.js': adapt_workbench(sources['workbench.js']),
    }
    verified = True
    for name, content in sources.items():
        blob = subprocess.run(['git', '-C', str(source_root), 'show', revision + ':public/' + name], capture_output=True)
        if blob.returncode or blob.stdout.decode('utf-8').replace('\r\n', '\n') != content:
            verified = False
            break
    provenance = {
        'contract_version': 1, 'generator': GENERATOR,
        'repository': 'https://github.com/collieai-g/BlueSAi-Cs-0001',
        'revision': revision, 'source_revision_verified': verified,
        'source_status': 'commit-verified assets' if verified else 'working-tree candidate; input digests are authoritative',
        'deployment_status': 'not installed or deployed by this generator',
        'renderer': 'bluesai-management/1', 'api': 'bluesai-management-api/1', 'license': 'MIT',
        'normalization': 'UTF-8, LF line endings',
        'original_assets': {'public/' + name: digest(content) for name, content in sources.items()},
        'generator_assets': {name: digest((ROOT / name).read_text(encoding='utf-8'))
                             for name in ('tools/build-blueprint-card.py', 'tools/build-workbench.py')},
        'template_assets': {name: digest(content) for name, content in templates.items()},
        'host_assets': {name: digest(content) for name, content in assets.items()},
        'transformations': ['build-time component tree; no runtime HTML injection',
                            'scoped module lifecycle; SSE disabled by host contract',
                            'canonical endpoint methods with host identity and write guards',
                            'canonical component CSS with host-owned bounds'],
        'excluded_assets': ['standalone login/page', 'diagnostic shell', 'vendor CSS', 'host server adapter', 'private bindings and data'],
    }
    assets['PROVENANCE.json'] = json.dumps(provenance, ensure_ascii=False, indent=2) + '\n'
    return assets


def validate_output(output, writing):
    # No source or installed checkout is a build destination. Existing outputs
    # must belong exclusively to this generator; never overwrite a live host.
    absolute = output.absolute()
    for path in (absolute, *absolute.parents):
        if path.is_symlink() or (path.exists() and getattr(path, 'is_junction', lambda: False)()):
            raise ValueError('Output cannot traverse links or junctions')
    output = absolute.resolve()
    if output == ROOT or ROOT in output.parents or any((path / '.git').exists() for path in (output, *output.parents)):
        raise ValueError('Output must be an independent directory outside source checkouts')
    if output.exists() and not output.is_dir():
        raise ValueError('Output must be a directory')
    if output.exists():
        entries = list(output.iterdir())
        allowed = {*OUTPUT_ASSETS, 'PROVENANCE.json'}
        if any(item.name not in allowed or not item.is_file() or item.is_symlink() for item in entries):
            raise ValueError('Output contains files not owned by this generator')
        if writing and entries:
            receipt = output / 'PROVENANCE.json'
            if not receipt.is_file() or json.loads(receipt.read_text(encoding='utf-8')).get('generator') != GENERATOR:
                raise ValueError('Refusing to overwrite an unowned artifact directory')
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-revision', required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--check', action='store_true', help='Compare an artifact without overwriting it')
    args = parser.parse_args()
    try:
        output = validate_output(args.output_dir, writing=not args.check)
        assets = build_assets(ROOT, args.source_revision)
        if args.check:
            drift = [name for name, value in assets.items() if not (output / name).is_file()
                     or (output / name).read_text(encoding='utf-8') != value]
            if drift:
                raise ValueError('Native generated UI drift: ' + ', '.join(drift))
            print('Native card assets match canonical UI and reviewed host templates.')
        else:
            output.mkdir(parents=True, exist_ok=True)
            for name, value in assets.items():
                (output / name).write_text(value, encoding='utf-8', newline='\n')
            print('Generated six native card assets and provenance; no host was installed or modified.')
        return 0
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
