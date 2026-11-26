"""Knowledge bases: documents at ``{data}/knowledge/{id}/{docId}{ext}``. / 知识库文档存储。"""
from __future__ import annotations
from pathlib import Path
import shutil
from ..schemas import KnowledgeInput
from .common import Collection, NotFound, now, safe_filename, suffix, uid

MAX_DOCUMENT = 20 * 1024 * 1024
# Extensions the engine knowledge plugin can parse. / 引擎知识库插件可解析的扩展名。
EXTENSIONS = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.rst': 'text/x-rst',
    '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.toml': 'application/toml',
    '.py': 'text/x-python', '.js': 'text/javascript', '.ts': 'text/typescript', '.pdf': 'application/pdf',
}


class KnowledgeService:
    def __init__(self, db, data: Path, providers):
        self.providers = providers
        self.items = Collection(db, 'knowledge', '知识库')
        self.docs = Collection(db, 'knowledge_doc', '文档')
        self.root = data / 'knowledge'

    def dir(self, ident: str) -> Path:
        return self.root / ident

    def documents(self, ident: str) -> list[dict]:
        self.items.get(ident)
        return [d for d in self.docs.all() if d['knowledgeId'] == ident]

    def public(self, row: dict) -> dict:
        docs = [d for d in self.docs.all() if d['knowledgeId'] == row['id']]
        return {**row, 'documentCount': len(docs), 'totalBytes': sum(d['size'] for d in docs)}

    def public_doc(self, doc: dict) -> dict:
        return {k: doc[k] for k in ('id', 'title', 'size', 'contentType', 'createdAt')}

    def list(self) -> list[dict]:
        return [self.public(r) for r in self.items.all()]

    def save(self, body: KnowledgeInput, ident: str | None = None) -> dict:
        if body.embedding_model is not None:
            resolved = self.providers.resolve(body.embedding_model)
            if not resolved or resolved[1]['type'] != 'embedding':
                raise ValueError('向量模型不存在或不是 embedding 类型')
        old = self.items.get(ident) if ident else None
        stamp = now()
        row = {**body.dump(), 'id': ident or uid(), 'createdAt': old['createdAt'] if old else stamp, 'updatedAt': stamp}
        self.dir(row['id']).mkdir(parents=True, exist_ok=True)
        return self.public(self.items.put(row))

    def delete(self, ident: str) -> None:
        self.items.remove(ident)
        for doc in self.docs.all():
            if doc['knowledgeId'] == ident:
                self.docs.remove(doc['id'])
        shutil.rmtree(self.dir(ident), ignore_errors=True)

    def add(self, ident: str, filename: str, content: bytes) -> dict:
        kb = self.items.get(ident)
        if len(content) > MAX_DOCUMENT:
            raise ValueError('单个文档不能超过 20 MB')
        ext = suffix(filename)
        if ext not in EXTENSIONS:
            raise ValueError(f'不支持的文档类型：{ext or "无扩展名"}，支持 {" ".join(sorted(EXTENSIONS))}')
        doc_id = uid()
        folder = self.dir(ident)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f'{doc_id}{ext}').write_bytes(content)
        doc = {'id': doc_id, 'knowledgeId': ident, 'title': safe_filename(filename), 'size': len(content),
               'contentType': EXTENSIONS[ext], 'ext': ext, 'createdAt': now()}
        self.docs.put(doc)
        self.items.put({**kb, 'updatedAt': now()})
        return self.public_doc(doc)

    def add_text(self, ident: str, title: str, content: str) -> dict:
        name = safe_filename(title, 'document')
        if suffix(name) not in ('.md', '.txt'):
            name += '.md'
        doc = self.add(ident, name, content.encode('utf-8'))
        stored = self.docs.get(doc['id'])
        self.docs.put({**stored, 'title': title.strip()})
        return {**doc, 'title': title.strip()}

    def document(self, ident: str, doc_id: str) -> tuple[dict, Path]:
        doc = self.docs.get(doc_id)
        if doc['knowledgeId'] != ident:
            raise NotFound('文档不存在')
        return doc, self.dir(ident) / f"{doc_id}{doc['ext']}"

    def remove_document(self, ident: str, doc_id: str) -> None:
        doc, path = self.document(ident, doc_id)
        self.docs.remove(doc_id)
        path.unlink(missing_ok=True)
        self.items.put({**self.items.get(ident), 'updatedAt': now()})

    def embedding_models(self, ids: list[str]) -> set[str | None]:
        """Embedding ModelRefs of enabled bound bases (None = keyword only). / 已启用知识库的向量模型。"""
        return {kb['embeddingModel'] for i in ids if (kb := self.items.find(i)) and kb['enabled']}
    def sources(self, ids: list[str]) -> list[str]:
        """Document paths of enabled bound bases. / 已启用知识库的文档路径。"""
        out = []
        for ident in ids:
            kb = self.items.find(ident)
            if kb and kb['enabled']:
                out += [str(self.dir(ident) / f"{d['id']}{d['ext']}") for d in self.documents(ident)]
        return out
