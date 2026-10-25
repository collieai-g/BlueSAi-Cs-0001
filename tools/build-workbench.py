"""Build the local page from the reviewed design; network behavior stays separate."""
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'design' / 'customer-agent-card-design.html'
fragment = source.read_text(encoding='utf-8')
styles = re.findall(r'<style>([\s\S]*?)</style>', fragment)
scripts = re.findall(r'<script>([\s\S]*?)</script>', fragment)
markup = re.sub(r'<(?:style|script)>[\s\S]*?</(?:style|script)>', '', fragment)
markup = re.sub(r'(?m)^[ \t]+$', '', markup)
markup = markup.replace('id="cs-card-design"', 'id="cs-card-design" hidden', 1)
login = '''<section class="local-login" data-local-login>
<img src="/brand.svg" alt="Blueprint" width="40" height="40"><h1>本機客服工作台</h1><p>BlueSAi-Cs-#0001 · 你的獨立實測空間</p>
<form data-local-login-form><label>管理員密碼<input name="token" type="password" autocomplete="current-password" required></label><button type="submit">登入工作台</button></form>
<p data-login-error role="alert"></p><p>請使用此服務的管理員密碼。客服執行器使用 BLUEPRINT_DATA_DIR/admin-token；隔離預覽使用 .bluesai-local-workbench/admin-token。在本機讀取，毋須貼到聊天。</p></section>'''
html = '''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BlueSAi-Cs-0001｜本機 Agent 工作台</title><link rel="icon" href="/brand.svg"><link rel="stylesheet" href="/workbench.css"><script src="/workbench-api.js" defer></script><script src="/agent-handoff.js" defer></script><script src="/workbench.js" defer></script></head><body>''' + login + markup + '</body></html>'
css = '\n'.join(styles) + '''
body{margin:0;background:#fff;color:#282c31;font-family:Arial,"Microsoft JhengHei",sans-serif}body [hidden]{display:none!important}#cs-card-design{color-scheme:light}#cs-card-design .bp-window{min-height:100vh}.local-login{max-width:420px;margin:10vh auto;padding:28px;border:1px solid #e8ebef;border-radius:12px}.local-login h1{font-size:24px}.local-login p{font-size:13px;line-height:1.7;color:#69727d;overflow-wrap:anywhere}.local-login label{display:grid;gap:8px}.local-login input{padding:12px;font:inherit;border:1px solid #dfe3e8;border-radius:7px;min-width:0}.local-login button{margin-top:16px;padding:12px 16px;background:#343b43;color:white;border:0;border-radius:7px;font:inherit}#cs-card-design .bp-top-right{padding-right:0}@media(max-width:560px){.local-login{margin:32px 12px;padding:22px}.local-login input{font-size:16px}}
'''
(root / 'public' / 'workbench.html').write_text(html, encoding='utf-8', newline='\n')
(root / 'public' / 'workbench.css').write_text(re.sub(r'(?m)^[ \t]+$', '', css), encoding='utf-8', newline='\n')
icons = re.search(r'const icons = (\{[\s\S]*?\n\});', (root / 'public' / 'app.js').read_text(encoding='utf-8')).group(1)
local_icons = '''(() => {
const icons = ICON_MAP;
const names={'layout-grid':'dashboard','list-checks':'checklist','folder':'folder','message-circle':'chat','headset':'chat','settings':'settings','arrow-right':'arrow','arrow-left':'arrow','panel-left':'menu','archive':'inbox','file-text':'checklist'};
document.querySelectorAll('[data-lucide]').forEach(node=>{const paths=icons[names[node.dataset.lucide]];if(!paths)return;const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);for(const d of paths){const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',d);svg.append(path);}if(node.dataset.lucide==='arrow-left')svg.style.transform='rotate(180deg)';node.append(svg);});
})();
'''.replace('ICON_MAP', icons)
(root / 'public' / 'workbench.js').write_text(local_icons + '\n'.join(scripts), encoding='utf-8', newline='\n')
print('Built local workbench: HTML, CSS, JS')
