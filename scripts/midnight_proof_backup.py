#!/usr/bin/env python3
import argparse
from contextlib import closing
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import tempfile
import time
import uuid

TABLES={
    'proof_objects':('network','kind','digest','body'),
    'member_leaves':('network','genesis','leaf','anchor_id','digest'),
    'object_candidates':('network','kind','genesis','registry','subject','digest'),
}
NAME=re.compile(r'objects-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{32}\.sqlite')

def private(path,directory=False):
    info=path.lstat()
    if path.resolve()!=path.absolute() or info.st_uid!=os.getuid() or info.st_mode&0o077 or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError('backup paths must be private and owned')

def flush(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)

def validate(db):
    if db.execute('pragma user_version').fetchone()!=(1,):raise ValueError('unsupported proof schema')
    tables={row[0] for row in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")}
    if tables!=set(TABLES):raise ValueError('not a proof store database')
    for table,columns in TABLES.items():
        if tuple(row[1] for row in db.execute(f'pragma table_info({table})'))!=columns:raise ValueError('proof columns differ')
    if db.execute('pragma quick_check').fetchall()!=[('ok',)]:raise ValueError('proof database integrity failed')

def logical(db):
    digest=hashlib.sha256();counts={}
    for table,columns in TABLES.items():
        count=0
        for row in db.execute(f'select * from {table} order by '+','.join(columns)):
            if table=='proof_objects':
                network,kind,claimed,body=row
                if network not in ('mainnet','preprod') or kind not in ('members','plans','sets') or not isinstance(body,str) or hashlib.sha256(body.encode()).hexdigest()!=claimed:
                    raise ValueError('proof object digest differs')
            digest.update(json.dumps([table,*row],ensure_ascii=True,separators=(',',':')).encode()+b'\n');count+=1
        counts[table]=count
    return digest.digest(),counts

def backup(source,destination):
    source,destination=Path(source),Path(destination)
    if not source.is_absolute() or not destination.is_absolute():raise ValueError('absolute backup paths required')
    private(source.parent,True);private(source);private(destination,True)
    if destination==source.parent or source.parent in destination.parents:raise ValueError('backup must be outside live storage')
    lock=os.open(destination/'backup.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    partial=None
    try:
        private(destination/'backup.lock');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        retained=[]
        for path in destination.iterdir():
            if NAME.fullmatch(path.name):private(path);retained.append(path)
        deadline=time.monotonic()+30
        def progress(*unused):
            if time.monotonic()>deadline:raise TimeoutError('backup deadline exceeded')
        with closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=5)) as live:
            live.execute('pragma query_only=on')
            live.set_progress_handler(lambda: int(time.monotonic()>deadline),1000)
            live.execute('begin');validate(live)
            fd,name=tempfile.mkstemp(prefix='.partial-',dir=destination);os.close(fd);partial=Path(name)
            with closing(sqlite3.connect(partial,timeout=5)) as target:
                live.backup(target,pages=256,progress=progress,sleep=0.05)
                target.set_progress_handler(lambda: int(time.monotonic()>deadline),1000)
                validate(target)
                expected,counts=logical(live)
                if logical(target)!=(expected,counts):raise ValueError('backup logical content differs')
            live.rollback()
        fd=os.open(partial,os.O_RDONLY|os.O_NOFOLLOW)
        try:os.fsync(fd)
        finally:os.close(fd)
        with partial.open('rb') as content:digest=hashlib.file_digest(content,'sha256').hexdigest()
        final=destination/f'objects-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex}.sqlite'
        os.link(partial,final,follow_symlinks=False);flush(destination)
        partial.unlink();partial=None;flush(destination)
        for path in sorted(retained,key=lambda value:value.name,reverse=True)[47:]:
            private(path);path.unlink()
        flush(destination)
        return {'event':'midnight-proof-backup','file':final.name,'sha256':digest,'objects':counts['proof_objects']}
    finally:
        if partial is not None:partial.unlink(missing_ok=True)
        os.close(lock)

def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,required=True);parser.add_argument('--destination',type=Path,required=True)
    args=parser.parse_args()
    try:print(json.dumps(backup(args.source,args.destination)));return 0
    except (OSError,ValueError,sqlite3.Error):
        print('Midnight proof backup failed; retained snapshots were not replaced',file=sys.stderr);return 1

if __name__=='__main__':raise SystemExit(main())
