"""Only synthetic temporary auth trees; never inspect an installed bridge."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import relink_auth as relink


class RelinkTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="synthetic-bluesai-relink-")
        self.root = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        self.auth = self.root / "auth"
        self.auth.mkdir()
        (self.auth / "creds.json").write_text('{"synthetic":"old-private-value"}', encoding="utf-8")
        (self.auth / "nested").mkdir()
        (self.auth / "nested" / "key.json").write_bytes(b"synthetic-key-only")
        self.original = relink.fingerprint(self.auth)
        self.pid_patch = patch.object(relink, "pid_running", return_value=False)
        self.pid_patch.start()
        self.addCleanup(self.pid_patch.stop)

    def call(self, action="prepare", **overrides):
        arguments = dict(data_dir=self.root, operation="synthetic-op-1", expected_pid=123456,
                         expected_fingerprint=self.original["digest"], reason="logged_out", consent=True)
        arguments.update(overrides)
        return relink.maintain(action, **arguments)

    def assert_code(self, code, callback):
        with self.assertRaisesRegex(relink.RelinkError, "^" + code + "$"):
            callback()

    def test_prepare_and_reentry_preserve_every_byte(self):
        self.assertEqual(self.call()["status"], "prepared")
        self.assertFalse(self.auth.exists())
        old = self.root / "auth-archives" / "synthetic-op-1"
        self.assertEqual(relink.fingerprint(old), self.original)
        self.assertEqual(self.call()["status"], "already_prepared")
        self.assertFalse((self.root / "bridge.lock").exists())
        receipt = json.loads((self.root / "auth-archives/receipts/synthetic-op-1/prepare.json").read_text())
        self.assertEqual(receipt["binding"]["digest"], self.original["digest"])
        self.assertNotIn("old-private-value", json.dumps(receipt))

    def test_prepare_retry_never_rotates_new_auth(self):
        self.call()
        self.auth.mkdir()
        (self.auth / "fresh.json").write_text("synthetic-fresh", encoding="utf-8")
        fresh = relink.fingerprint(self.auth)
        self.assertEqual(self.call()["status"], "already_prepared")
        self.assertEqual(relink.fingerprint(self.auth), fresh)

    def test_active_process_and_existing_lock_block_before_move(self):
        with patch.object(relink, "pid_running", return_value=True):
            self.assert_code("PROCESS_STILL_RUNNING", self.call)
        lock = self.root / "bridge.lock"
        lock.write_text("synthetic-other-owner", encoding="ascii")
        self.assert_code("BRIDGE_LOCK_PRESENT", self.call)
        self.assertEqual(lock.read_text(), "synthetic-other-owner")
        self.assertEqual(relink.fingerprint(self.auth), self.original)

    def test_pid_rechecked_under_exclusive_maintenance_lock(self):
        with patch.object(relink, "pid_running", side_effect=[False, True]):
            self.assert_code("PROCESS_STILL_RUNNING", self.call)
        self.assertFalse((self.root / "bridge.lock").exists())
        self.assertEqual(relink.fingerprint(self.auth), self.original)

    def test_reason_consent_operation_fingerprint_are_required(self):
        for values in ({"reason": "connection_closed"}, {"consent": False}):
            self.assert_code("CONSENT_OR_REASON_REQUIRED", lambda: self.call(**values))
        self.assert_code("INVALID_OPERATION", lambda: self.call(operation="../auth"))
        self.assert_code("INVALID_FINGERPRINT", lambda: self.call(expected_fingerprint="bad"))
        self.assert_code("FINGERPRINT_MISMATCH", lambda: self.call(expected_fingerprint="0" * 64))
        self.assertEqual(relink.fingerprint(self.auth), self.original)

    def test_git_ancestor_and_auth_symlink_are_rejected(self):
        (self.root / ".git").mkdir()
        self.assert_code("GIT_DIRECTORY_FORBIDDEN", self.call)
        (self.root / ".git").rmdir()
        link = self.auth / "link"
        try:
            link.symlink_to(self.auth / "creds.json")
        except OSError:
            self.skipTest("OS does not permit synthetic symlink creation")
        self.assert_code("UNSAFE_PATH", self.call)

    def test_windows_reparse_point_is_rejected_without_following(self):
        original_lstat = Path.lstat
        def reparse(path, *args, **kwargs):
            value = original_lstat(path, *args, **kwargs)
            if path == self.auth:
                return SimpleNamespace(st_mode=value.st_mode, st_file_attributes=0x400)
            return value
        with patch.object(Path, "lstat", reparse):
            self.assert_code("UNSAFE_PATH", self.call)
        self.assertEqual(relink.fingerprint(self.auth), self.original)

    def test_prepare_atomic_rename_failure_leaves_original_and_can_resume(self):
        with patch.object(relink.os, "rename", side_effect=OSError("synthetic-failure")):
            with self.assertRaises(OSError):
                self.call()
        self.assertEqual(relink.fingerprint(self.auth), self.original)
        self.assertFalse((self.root / "auth-archives/synthetic-op-1").exists())
        self.assertEqual(self.call()["status"], "prepared")

    def test_prepare_receipt_publication_failure_never_moves_auth(self):
        with patch.object(relink.os, "link", side_effect=OSError("synthetic-failure")):
            with self.assertRaises(OSError):
                self.call()
        self.assertEqual(relink.fingerprint(self.auth), self.original)
        self.assertFalse((self.root / "auth-archives/synthetic-op-1").exists())

    def test_prepare_recovers_after_rename_before_final_receipt(self):
        original_write = relink._write
        def interrupted(path, value):
            if path.name == "prepared.json":
                raise OSError("synthetic-receipt-interruption")
            return original_write(path, value)
        with patch.object(relink, "_write", side_effect=interrupted):
            with self.assertRaises(OSError):
                self.call()
        self.assertFalse(self.auth.exists())
        self.assertEqual(self.call()["status"], "already_prepared")

    def test_restore_preserves_fresh_auth_and_is_idempotent(self):
        self.call()
        self.auth.mkdir()
        (self.auth / "fresh.json").write_text("synthetic-fresh", encoding="utf-8")
        fresh = relink.fingerprint(self.auth)
        self.assertEqual(self.call("restore")["status"], "restored")
        self.assertEqual(relink.fingerprint(self.auth), self.original)
        archives = list((self.root / "auth-archives").glob("synthetic-op-1-fresh-*"))
        self.assertEqual(len(archives), 1)
        self.assertEqual(relink.fingerprint(archives[0]), fresh)
        self.assertEqual(self.call("restore")["status"], "already_restored")
        self.assertEqual(self.call()["status"], "already_restored")
        self.assertEqual(len(list((self.root / "auth-archives").glob("synthetic-op-1-fresh-*"))), 1)

    def test_restore_without_fresh_auth(self):
        self.call()
        self.assertEqual(self.call("restore")["status"], "restored")
        self.assertEqual(relink.fingerprint(self.auth), self.original)
        self.assertEqual(list((self.root / "auth-archives").glob("*-fresh-*")), [])

    def test_restore_interrupted_after_fresh_preservation_resumes(self):
        self.call()
        self.auth.mkdir()
        (self.auth / "fresh.json").write_text("synthetic-fresh", encoding="utf-8")
        fresh = relink.fingerprint(self.auth)
        original_rename = relink._rename
        def interrupted(source, target, root):
            if target == self.auth:
                raise OSError("synthetic-restore-failure")
            return original_rename(source, target, root)
        with patch.object(relink, "_rename", side_effect=interrupted):
            with self.assertRaises(OSError):
                self.call("restore")
        self.assertFalse(self.auth.exists())
        self.assertEqual(self.call("restore")["status"], "restored")
        archives = list((self.root / "auth-archives").glob("*-fresh-*"))
        self.assertEqual(relink.fingerprint(archives[0]), fresh)
        self.assertEqual(relink.fingerprint(self.auth), self.original)

    def test_restore_interrupted_after_old_auth_restored_resumes(self):
        self.call()
        original_write = relink._write
        def interrupted(path, value):
            if path.name == "restored.json":
                raise OSError("synthetic-receipt-interruption")
            return original_write(path, value)
        with patch.object(relink, "_write", side_effect=interrupted):
            with self.assertRaises(OSError):
                self.call("restore")
        self.assertEqual(relink.fingerprint(self.auth), self.original)
        self.assertEqual(self.call("restore")["status"], "restored")

    def test_unknown_archive_and_receipt_binding_never_adopt_or_overwrite(self):
        archives = self.root / "auth-archives"
        archives.mkdir()
        (archives / "synthetic-op-1").mkdir()
        self.assert_code("UNOWNED_ARCHIVE", self.call)
        self.assertEqual(relink.fingerprint(self.auth), self.original)

    def test_archive_corruption_blocks_restore(self):
        self.call()
        (self.root / "auth-archives/synthetic-op-1/creds.json").write_text("synthetic-changed")
        self.assert_code("ARCHIVE_MISMATCH", lambda: self.call("restore"))
        self.assertFalse(self.auth.exists())

    def test_same_filesystem_is_required_before_rename(self):
        target = self.root / "archive"
        target.mkdir()
        original_stat = Path.stat
        def changed_device(path, *args, **kwargs):
            value = original_stat(path, *args, **kwargs)
            return SimpleNamespace(st_dev=value.st_dev + 1) if path == target and kwargs.get("follow_symlinks", True) else value
        with patch.object(Path, "stat", changed_device), patch.object(relink.os, "rename") as rename:
            self.assert_code("SAME_FILESYSTEM_REQUIRED", lambda: relink._rename(self.auth, target / "old", self.root))
            rename.assert_not_called()

    def test_destination_is_never_overwritten(self):
        target = self.root / "existing"
        target.mkdir()
        (target / "keep").write_text("synthetic-existing")
        self.assert_code("DESTINATION_EXISTS", lambda: relink._rename(self.auth, target, self.root))
        self.assertEqual((target / "keep").read_text(), "synthetic-existing")

    def test_rename_rejects_source_or_destination_outside_private_root(self):
        with tempfile.TemporaryDirectory(prefix="synthetic-relink-outside-") as outside:
            external = Path(outside).resolve()
            (external / "source").mkdir()
            self.assert_code("TARGET_OUTSIDE_PRIVATE_DIRECTORY", lambda: relink._rename(self.auth, external / "target", self.root))
            self.assert_code("TARGET_OUTSIDE_PRIVATE_DIRECTORY", lambda: relink._rename(external / "source", self.root / "target", self.root))
        self.assertEqual(relink.fingerprint(self.auth), self.original)

    def test_fingerprint_returns_no_names_or_contents_and_prints_nothing(self):
        output = io.StringIO()
        with redirect_stdout(output):
            result = relink.fingerprint(self.auth)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(set(result), {"count", "digest"})
        self.assertEqual(result["count"], 2)
        for forbidden in (str(self.auth), "creds.json", "key.json", "old-private-value", "synthetic-key-only"):
            self.assertNotIn(forbidden, json.dumps(result))

    def test_cli_output_contains_only_status_count_and_digest(self):
        output = io.StringIO()
        arguments = ["prepare", "--data-dir", str(self.root), "--operation", "synthetic-op-1",
                     "--expected-pid", "123456", "--expected-fingerprint", self.original["digest"],
                     "--reason", "logged_out", "--consent"]
        with redirect_stdout(output):
            code = relink.main(arguments)
        self.assertEqual(code, 0)
        self.assertEqual(set(json.loads(output.getvalue())), {"status", "count", "digest"})
        for forbidden in (str(self.root), "creds.json", "old-private-value", "synthetic-key-only"):
            self.assertNotIn(forbidden, output.getvalue())


class ActualPidTests(unittest.TestCase):
    def test_current_and_finished_synthetic_process(self):
        self.assertTrue(relink.pid_running(os.getpid()))
        child = subprocess.Popen([sys.executable, "-c", "pass"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        child.wait(timeout=10)
        self.assertFalse(relink.pid_running(child.pid))


if __name__ == "__main__":
    unittest.main()
