"""Provider secret encryption. / 模型提供商密钥加密。

The Fernet key comes from ``AXC_SECRET_KEY``; when unset, one is generated into ``{data}/secret.key``
(mode 0600) so local development works out of the box.
Fernet 密钥取自 ``AXC_SECRET_KEY``；未设置时自动生成到 ``{data}/secret.key``（权限 0600）。
"""
import logging
import os
from pathlib import Path
from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)


class SecretBox:
    def __init__(self, data: Path):
        key = os.environ.get('AXC_SECRET_KEY', '').strip()
        if not key:
            path = Path(data) / 'secret.key'
            if path.exists():
                key = path.read_text().strip()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                key = Fernet.generate_key().decode()
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w') as handle:
                    handle.write(key)
                logger.warning('AXC_SECRET_KEY 未设置，已生成本地密钥文件 %s；生产环境请通过环境变量提供。', path)
        try:
            self.fernet = Fernet(key.encode())
        except ValueError as exc:
            raise ValueError('AXC_SECRET_KEY 不是有效的 Fernet 密钥') from exc

    def encrypt(self, plain: str) -> str:
        return self.fernet.encrypt(plain.encode()).decode() if plain else ''

    def decrypt(self, token: str) -> str:
        if not token:
            return ''
        try:
            return self.fernet.decrypt(token.encode()).decode()
        except InvalidToken as exc:
            raise ValueError('无法解密已保存的密钥，请检查 AXC_SECRET_KEY') from exc


def mask(secret: str) -> str:
    """``sk-••••abcd``; short secrets reveal nothing. / 短密钥不泄露任何字符。"""
    if not secret:
        return ''
    if len(secret) <= 8:
        return '••••'
    return f'{secret[:3]}••••{secret[-4:]}'
