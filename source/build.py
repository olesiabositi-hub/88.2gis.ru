"""Собирает index.html в корне репозитория из source/template.html.

Запуск из корня репозитория:  python3 source/build.py
Шаблон содержит метку /*FONTFACE*/, на её место подставляются шрифты SB Sans Text.
"""
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'source', 'template.html'), encoding='utf-8').read()
W = {'Regular': 400, 'Medium': 500, 'SemiBold': 600}
ff = '\n'.join(
    f'@font-face{{font-family:"SB Sans Text";src:url(assets/fonts/SBSansText-{n}.woff) format("woff");'
    f'font-weight:{w};font-style:normal;font-display:swap}}' for n, w in W.items())
body = src.replace('/*FONTFACE*/', ff)
cut = body.index('</style>') + len('</style>')
page = ('<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<meta name="theme-color" content="#0B130F">\n<link rel="icon" href="assets/img/2gis-logo.png">\n'
        + body[:cut] + '\n</head>\n<body>\n' + body[cut:] + '\n</body>\n</html>\n')
open(os.path.join(ROOT, 'index.html'), 'w', encoding='utf-8').write(page)
print('index.html собран')
