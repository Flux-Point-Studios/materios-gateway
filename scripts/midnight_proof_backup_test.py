import hashlib
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

from midnight_proof_backup import backup

SCHEMA='''
create table proof_objects(network text,kind text,digest text,body text,primary key(network,kind,digest)) without rowid;
create table member_leaves(network text,genesis text,leaf text,anchor_id text,digest text,primary key(network,genesis,leaf,digest)) without rowid;
create table object_candidates(network text,kind text,genesis text,registry text,subject text,digest text,primary key(network,kind,genesis,registry,subject,digest)) without rowid;
pragma user_version=1;
'''

class BackupTest(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name)
        self.source_dir=self.root/'live';self.source_dir.mkdir(mode=0o700)
        self.source=self.source_dir/'objects.sqlite'
        self.writer=sqlite3.connect(self.source)
        self.addCleanup(self.writer.close)
        self.writer.executescript(SCHEMA);self.writer.execute('pragma journal_mode=WAL')
        self.source.chmod(0o600)
        self.destination=self.root/'backups';self.destination.mkdir(mode=0o700)
        self.insert('original')

    def insert(self,body):
        digest=hashlib.sha256(body.encode()).hexdigest()
        with self.writer:
            self.writer.execute('insert into proof_objects values(?,?,?,?)',('mainnet','members',digest,body))
            self.writer.execute('insert into member_leaves values(?,?,?,?,?)',('mainnet','g','l',digest,digest))
            self.writer.execute('insert into object_candidates values(?,?,?,?,?,?)',('mainnet','plans','g','r',digest,digest))
        return digest

    def test_committed_wal_and_indexes_restore_without_changing_live_database(self):
        self.assertGreater(self.source.with_name('objects.sqlite-wal').stat().st_size,0)
        first=backup(self.source,self.destination)
        self.insert('later')
        second=backup(self.source,self.destination)
        self.assertNotEqual(first['file'],second['file'])
        self.assertEqual(first['objects'],1);self.assertEqual(second['objects'],2)
        with sqlite3.connect(self.destination/first['file']) as restored:
            self.assertEqual(restored.execute('pragma integrity_check').fetchall(),[('ok',)])
            self.assertEqual(restored.execute('select body from proof_objects').fetchall(),[('original',)])
            self.assertEqual(restored.execute('select count(*) from member_leaves').fetchone(),(1,))
            self.assertEqual(restored.execute('select count(*) from object_candidates').fetchone(),(1,))
        self.assertEqual(self.writer.execute('select count(*) from proof_objects').fetchone(),(2,))
        self.assertEqual(hashlib.sha256((self.destination/first['file']).read_bytes()).hexdigest(),first['sha256'])
        self.assertEqual((self.destination/first['file']).stat().st_mode&0o777,0o600)

    def test_missing_source_is_never_initialized(self):
        missing=self.source_dir/'missing.sqlite'
        with self.assertRaises((OSError,ValueError)):backup(missing,self.destination)
        self.assertFalse(missing.exists())

    def test_quota_database_is_refused(self):
        with self.writer:
            self.writer.execute('drop table object_candidates')
            self.writer.execute('create table read_budget(day integer,used integer,requests integer)')
        with self.assertRaises(ValueError):backup(self.source,self.destination)
        self.assertEqual(list(self.destination.glob('objects-*.sqlite')),[])

    def test_unversioned_database_is_refused(self):
        self.writer.execute('pragma user_version=0')
        with self.assertRaises(ValueError):backup(self.source,self.destination)

    def test_corrupt_object_hash_never_replaces_retained_backup(self):
        first=backup(self.source,self.destination)
        with self.writer:self.writer.execute("update proof_objects set body='changed'")
        with self.assertRaises(ValueError):backup(self.source,self.destination)
        self.assertEqual([p.name for p in self.destination.glob('objects-*.sqlite')],[first['file']])
        self.assertEqual(list(self.destination.glob('.partial-*')),[])

    def test_uncommitted_changes_are_excluded(self):
        self.writer.execute("update proof_objects set body='uncommitted'")
        result=backup(self.source,self.destination)
        with sqlite3.connect(self.destination/result['file']) as restored:
            self.assertEqual(restored.execute('select body from proof_objects').fetchone(),('original',))
        self.writer.rollback()

    def test_source_symlink_is_refused(self):
        link=self.source_dir/'link.sqlite';link.symlink_to(self.source)
        with self.assertRaises(ValueError):backup(link,self.destination)

    def test_destination_symlink_is_refused(self):
        link=self.root/'linked';link.symlink_to(self.destination,target_is_directory=True)
        with self.assertRaises(ValueError):backup(self.source,link)

    def test_public_source_file_is_refused(self):
        self.source.chmod(0o644)
        with self.assertRaises(ValueError):backup(self.source,self.destination)

    def test_public_destination_is_refused(self):
        self.destination.chmod(0o755)
        with self.assertRaises(ValueError):backup(self.source,self.destination)

    def test_live_directory_cannot_be_backup_destination(self):
        with self.assertRaises(ValueError):backup(self.source,self.source_dir)

    def test_backup_directory_inside_live_storage_is_refused(self):
        nested=self.source_dir/'backups';nested.mkdir(mode=0o700)
        with self.assertRaises(ValueError):backup(self.source,nested)

    def test_retention_keeps_current_and_unrelated_files(self):
        (self.destination/'read-rpc.sqlite').write_bytes(b'unrelated')
        for number in range(50):
            (self.destination/f'objects-20200101T000000Z-{number:032x}.sqlite').touch(mode=0o600)
        current=backup(self.source,self.destination)
        files=list(self.destination.glob('objects-*.sqlite'))
        self.assertEqual(len(files),48)
        self.assertIn(self.destination/current['file'],files)
        self.assertEqual((self.destination/'read-rpc.sqlite').read_bytes(),b'unrelated')

    def test_foreign_symlink_is_never_pruned(self):
        target=self.root/'preserved';target.write_bytes(b'keep')
        link=self.destination/('objects-20200101T000000Z-'+'f'*32+'.sqlite');link.symlink_to(target)
        with self.assertRaises(ValueError):backup(self.source,self.destination)
        self.assertTrue(link.is_symlink());self.assertEqual(target.read_bytes(),b'keep')

if __name__=='__main__':unittest.main()
