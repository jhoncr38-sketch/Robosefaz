"""Gera uma chave para SECRET_ENCRYPTION_KEY: `python -m app.tools.generate_key`."""

from cryptography.fernet import Fernet

if __name__ == "__main__":
    print(Fernet.generate_key().decode())
