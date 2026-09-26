"""Chamado pelo link siatrobo://abrir/<id> do painel (registrado pelo instalador).

Fica na pasta worker para que `import app` funcione sem mudar a pasta atual.
"""

from app.open_link import main

main()
