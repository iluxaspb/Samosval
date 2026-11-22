#!/usr/bin/env python3
"""Synthetic schema preparation. Never edits a production migration."""
import pathlib
import re
import sys

AUTH_GUARD = "current_database()<>'samosval_working_test_reserve'"

def migration_fixture(name, sql):
    if name == '018_auth_credentials.sql':
        if sql.count(AUTH_GUARD) != 1:
            raise ValueError('authentication guard changed: review fixture adapter')
        return sql.replace(AUTH_GUARD, "current_database()<>'samosval_test'", 1)
    return sql

def prepare(repo, base):
    base = base.resolve()
    if base.parent != repo.parent or not base.name.startswith(('browser-fix.', 'qa-fix-')):
        raise ValueError('only a dedicated sibling QA directory is allowed')
    socket = base / 'socket'
    if not socket.is_dir():
        raise ValueError('dedicated socket directory required')
    # This program writes SQL files only; callers enforce netns before psql.
    out = base / 'migrations'
    out.mkdir(exist_ok=True)
    for path in sorted((repo / 'server/sql').glob('*.sql')):
        (out / path.name).write_text(migration_fixture(path.name, path.read_text()))
    (out / '999_synthetic_import.sql').write_text('''
BEGIN;
DO $guard$ BEGIN IF current_database()<>'samosval_test' THEN RAISE EXCEPTION 'synthetic TEST database required'; END IF; END $guard$;
CREATE TABLE IF NOT EXISTS migration_imports (sha256 text PRIMARY KEY,workspace_id text NOT NULL,source_project text NOT NULL,exported_at bigint NOT NULL,imported_at timestamptz NOT NULL DEFAULT now(),counts jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS migration_documents (import_sha256 text NOT NULL REFERENCES migration_imports(sha256),document_path text NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(import_sha256,document_path));
COMMIT;
''')
    return out

if __name__ == '__main__':
    print(prepare(pathlib.Path(__file__).resolve().parents[1], pathlib.Path(sys.argv[1])))
