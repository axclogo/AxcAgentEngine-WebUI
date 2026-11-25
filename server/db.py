"""SQLite document store plus engine checkpoint/message adapters. / SQLite 文档存储与引擎检查点、消息适配。

Every record is a JSON document addressed by (bucket, key); tables are created on demand, no migrations.
所有记录都是按 (bucket, key) 寻址的 JSON 文档；表按需创建，无需迁移。
"""
import json
import sqlite3
from pathlib import Path
from axc_agent_engine import Checkpoint

class Database:
    def __init__(self, path):
        if path != ':memory:':
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute('CREATE TABLE IF NOT EXISTS records (bucket TEXT, key TEXT, value TEXT, PRIMARY KEY(bucket,key))')

    def put(self, bucket, key, value):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO records VALUES (?,?,?)', (bucket, key, json.dumps(value, ensure_ascii=False)))

    def get(self, bucket, key):
        row = self.db.execute('SELECT value FROM records WHERE bucket=? AND key=?', (bucket, key)).fetchone()
        return json.loads(row[0]) if row else None

    def items(self, bucket):
        return [(k, json.loads(v)) for k, v in self.db.execute('SELECT key,value FROM records WHERE bucket=?', (bucket,))]

    def values(self, bucket):
        return [v for _, v in self.items(bucket)]
    def close(self):
        self.db.close()
    def remove(self, bucket, key):
        with self.db:
            self.db.execute('DELETE FROM records WHERE bucket=? AND key=?', (bucket, key))

class Checkpoints:
    def __init__(self, db):
        self.db = db

    async def save(self, checkpoint):
        self.db.put('checkpoint', checkpoint.id, checkpoint.to_dict())

    async def list(self, run_id):
        return sorted([Checkpoint(**v) for _, v in self.db.items('checkpoint') if v['run_id'] == run_id], key=lambda c: c.sequence)

    async def latest(self, run_id):
        rows = await self.list(run_id)
        return rows[-1] if rows else None

    async def list_runs(self, status=None, kind=None):
        runs = {v['run_id'] for _, v in self.db.items('checkpoint')}
        out = []
        for run in runs:
            cp = await self.latest(run)
            if (status is None or cp.status == status) and (kind is None or cp.kind == kind):
                out.append(run)
        return out

    async def delete_run(self, run_id):
        for cp in await self.list(run_id):
            self.db.remove('checkpoint', cp.id)

class Messages:
    def __init__(self, db):
        self.db = db

    async def save(self, scope_id, session_id, messages):
        self.db.put('history', json.dumps([scope_id, session_id]), messages)

    async def load(self, scope_id, session_id):
        return self.db.get('history', json.dumps([scope_id, session_id])) or []

    async def delete(self, scope_id, session_id):
        self.db.remove('history', json.dumps([scope_id, session_id]))

    async def clear(self, scope_id):
        for key, _ in self.db.items('history'):
            if json.loads(key)[0] == scope_id:
                self.db.remove('history', key)
