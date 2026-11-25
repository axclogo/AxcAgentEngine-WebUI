"""Skills stored as ``{data}/skills/{id}/SKILL.md``. / 技能以 SKILL.md 存储。"""
import io
from pathlib import Path, PurePosixPath
import shutil
import stat
import zipfile
from pydantic import ValidationError
import yaml
from ..schemas import SkillInput
from .common import Collection, now, uid

MAX_IMPORT = 5 * 1024 * 1024


def parse_skill_markdown(text: str) -> dict:
    if not text.startswith('---'):
        raise ValueError('SKILL.md 缺少 YAML frontmatter')
    parts = text.split('---', 2)
    if len(parts) < 3:
        raise ValueError('SKILL.md frontmatter 未闭合')
    try:
        meta = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError as exc:
        raise ValueError('SKILL.md frontmatter 不是有效 YAML') from exc
    if not isinstance(meta, dict):
        raise ValueError('SKILL.md frontmatter 必须是对象')
    keywords = meta.get('trigger_keywords') or []
    if isinstance(keywords, str):
        keywords = [k.strip() for k in keywords.split(',') if k.strip()]
    return {
        'name': str(meta.get('name') or ''),
        'description': str(meta.get('description') or ''),
        'whenToUse': str(meta.get('when_to_use') or ''),
        'triggerKeywords': [str(k) for k in keywords],
        'instructions': parts[2].strip(),
        'enabled': True,
    }


def render_skill_markdown(skill: dict) -> str:
    meta = {'name': skill['name'], 'description': skill['description'], 'when_to_use': skill['whenToUse'],
            'trigger_keywords': skill['triggerKeywords']}
    return '---\n' + yaml.safe_dump(meta, allow_unicode=True, sort_keys=False) + '---\n\n' + skill['instructions'].strip() + '\n'


def _validate(data: dict) -> SkillInput:
    try:
        return SkillInput.model_validate(data)
    except ValidationError as exc:
        raise ValueError('；'.join(e['msg'].removeprefix('Value error, ') for e in exc.errors())) from exc


class SkillService:
    def __init__(self, db, data: Path):
        self.items = Collection(db, 'skill', '技能')
        self.root = data / 'skills'

    def dir(self, ident: str) -> Path:
        return self.root / ident

    def save(self, body: SkillInput, ident: str | None = None, files: dict[str, bytes] | None = None) -> dict:
        data = body.dump()
        self.items.unique_name(data['name'], ident)
        old = self.items.get(ident) if ident else None
        stamp = now()
        row = {**data, 'id': ident or uid(), 'createdAt': old['createdAt'] if old else stamp, 'updatedAt': stamp}
        folder = self.dir(row['id'])
        folder.mkdir(parents=True, exist_ok=True)
        for rel, content in (files or {}).items():
            target = folder / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        (folder / 'SKILL.md').write_text(render_skill_markdown(row), encoding='utf-8')
        return self.items.put(row)

    def delete(self, ident: str) -> None:
        self.items.remove(ident)
        shutil.rmtree(self.dir(ident), ignore_errors=True)

    def import_file(self, filename: str, content: bytes) -> dict:
        if len(content) > MAX_IMPORT:
            raise ValueError('技能包不能超过 5 MB')
        if filename.lower().endswith('.zip') or content[:4] == b'PK\x03\x04':
            markdown, files = self._read_zip(content)
        else:
            markdown, files = content, {}
        try:
            text = markdown.decode('utf-8-sig')
        except UnicodeDecodeError as exc:
            raise ValueError('SKILL.md 必须是 UTF-8 文本') from exc
        return self.save(_validate(parse_skill_markdown(text)), files=files)

    @staticmethod
    def _read_zip(content: bytes) -> tuple[bytes, dict[str, bytes]]:
        try:
            archive = zipfile.ZipFile(io.BytesIO(content))
        except zipfile.BadZipFile as exc:
            raise ValueError('不是有效的 zip 文件') from exc
        entries = [i for i in archive.infolist() if not i.is_dir()]
        total = 0
        for info in entries:
            path = PurePosixPath(info.filename.replace('\\', '/'))
            if path.is_absolute() or '..' in path.parts or ':' in info.filename:
                raise ValueError(f'zip 包含非法路径：{info.filename}')
            if stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError(f'zip 不允许包含符号链接：{info.filename}')
            total += info.file_size
            if total > MAX_IMPORT:
                raise ValueError('技能包解压后不能超过 5 MB')
        skill_md = sorted((PurePosixPath(i.filename) for i in entries if PurePosixPath(i.filename).name == 'SKILL.md'),
                          key=lambda p: len(p.parts))
        if not skill_md:
            raise ValueError('zip 中未找到 SKILL.md')
        root = skill_md[0].parent
        files = {}
        for info in entries:
            path = PurePosixPath(info.filename)
            try:
                rel = path.relative_to(root)
            except ValueError:
                continue
            if str(rel) != 'SKILL.md':
                files[str(rel)] = archive.read(info)
        return archive.read(str(skill_md[0])), files
