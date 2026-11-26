"""How a conversation run starts. / 会话一轮的开启方式。"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Turn:
    """How a new run starts: origin, provenance and the user message fields (W3.4). / 新一轮的开启方式。"""
    origin: str = 'user'
    personal: bool = False  # Typed by the user: resets wake-ups, consumes held notices. / 用户亲自发起。
    provenance: dict | None = None  # Dispatched run; else the conversation's own. / 派发轮的来源链。
    attachments: tuple = ()
    message: dict | None = None
    keep_title: bool = False
