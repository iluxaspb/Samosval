import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fixture', ROOT / 'tools/phone-qa-fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

class FixtureTests(unittest.TestCase):
    def test_only_known_auth_guard_is_adapted_and_guard_remains(self):
        for path in sorted((ROOT / 'server/sql').glob('*.sql')):
            original = path.read_text()
            adapted = fixture.migration_fixture(path.name, original)
            if path.name == '018_auth_credentials.sql':
                self.assertEqual(adapted.count("current_database()<>'samosval_test'"), 1)
                self.assertEqual(adapted, original.replace(fixture.AUTH_GUARD, "current_database()<>'samosval_test'", 1))
                self.assertIn('RAISE EXCEPTION', adapted)
            else:
                self.assertEqual(adapted, original)
    def test_guard_drift_is_fail_closed(self):
        for sql in ['', fixture.AUTH_GUARD * 2]:
            with self.assertRaises(ValueError):
                fixture.migration_fixture('018_auth_credentials.sql', sql)
    def test_rejects_non_qa_output_without_writing(self):
        with self.assertRaises(ValueError):
            fixture.prepare(ROOT, ROOT / 'server')

if __name__ == '__main__':
    unittest.main()
