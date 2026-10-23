"""Собирает index.html в корне репозитория из source/template.html.

Запуск из корня репозитория:  python3 source/build.py
Шаблон содержит метку /*FONTFACE*/, на её место подставляются шрифты SB Sans Text.
"""
import base64
import hashlib
import os
import re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'source', 'template.html'), encoding='utf-8').read()
W = {'Regular': 400, 'Medium': 500, 'SemiBold': 600}
ff = '\n'.join(
    f'@font-face{{font-family:"SB Sans Text";src:url(assets/fonts/SBSansText-{n}.woff) format("woff");'
    f'font-weight:{w};font-style:normal;font-display:swap}}' for n, w in W.items())
body = src.replace('/*FONTFACE*/', ff)
cut = body.index('</style>') + len('</style>')

# Типографика: неразрывный пробел после коротких предлогов и союзов, перед тире,
# между инициалами и фамилией, между числом и единицей. CSS (до </style>) не трогаем.
NB = ' '
SHORT = ('в|во|к|ко|с|со|у|о|об|обо|и|а|но|да|на|за|по|от|до|из|не|ни|для|при|без|под|над|про|или|что|как|это|же')
_short = re.compile(r'(?<![А-Яа-яЁёA-Za-z0-9\-])(' + SHORT + r') (?=\S)', re.I)
_dash = re.compile(r' (—|–)(?= )')
_init = re.compile(r'(?<![А-Яа-яЁё])([А-ЯЁ]\.) (?=[А-ЯЁ])')
_unit = re.compile(r'(\d) (?=(км/ч|км|мс|м|лет|год|года|кадров|ключевых|вариантов)(?![А-Яа-яЁё]))')


def typo(t):
    for _ in range(2):  # «и в городе»: два коротких слова подряд
        t = _short.sub(lambda m: m.group(1) + NB, t)
    t = _dash.sub(NB + r'\1', t)
    t = _init.sub(r'\1' + NB, t)
    t = _unit.sub(r'\1' + NB, t)
    return t


body = body[:cut] + typo(body[cut:])

# Политика безопасности контента (CSP). GitHub Pages не даёт задать HTTP-заголовки,
# поэтому политика ставится через <meta>. Встроенный скрипт разрешается по SHA-256 хешу,
# который пересчитывается при каждой сборке. Всё остальное грузится только с этого же сайта.
scripts = re.findall(r'<script>(.*?)</script>', body, re.S)
assert len(scripts) == 1, 'ожидается ровно один встроенный <script>'
sha = base64.b64encode(hashlib.sha256(scripts[0].encode('utf-8')).digest()).decode()
CSP = '; '.join([
    "default-src 'none'",
    f"script-src 'sha256-{sha}'",
    "style-src 'self' 'unsafe-inline'",   # style="" в разметке и в шаблонах JS
    "img-src 'self' data: blob:",          # data: — иконки в CSS, blob: — сохранение «Письма» картинкой
    "font-src 'self'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "upgrade-insecure-requests",
])
page = ('<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
        f'<meta http-equiv="Content-Security-Policy" content="{CSP}">\n'
        '<meta name="referrer" content="strict-origin-when-cross-origin">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<meta name="theme-color" content="#0B130F">\n<link rel="icon" href="assets/img/2gis-logo.png">\n'
        + body[:cut] + '\n</head>\n<body>\n' + body[cut:] + '\n</body>\n</html>\n')
open(os.path.join(ROOT, 'index.html'), 'w', encoding='utf-8').write(page)
print('index.html собран')
