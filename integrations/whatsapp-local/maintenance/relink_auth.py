"""離線重新配對維護：只搬移私人 auth，不啟動服務、連網或刪除登入資料。"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid


class RelinkError(Exception):
    """Only fixed codes may reach stdout; never expose paths or provider data."""


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise RelinkError(code)


def _plain(path: Path) -> None:
    info = path.lstat()
    _require(not stat.S_ISLNK(info.st_mode) and not getattr(info, "st_file_attributes", 0) & 0x400,
             "UNSAFE_PATH")


def _private_root(value: str | Path) -> Path:
    path = Path(value)
    _require(path.is_absolute() and path.is_dir(), "PRIVATE_DIRECTORY_REQUIRED")
    # Inspect lexical ancestors before resolve(), including Windows junctions.
    for item in (path, *path.parents):
        _plain(item)
        _require(not (item / ".git").exists(), "GIT_DIRECTORY_FORBIDDEN")
    _require(path.resolve() == path, "UNSAFE_PATH")
    return path


def fingerprint(path: str | Path) -> dict:
    """Read bytes only to hash them; no contents or filenames are returned."""
    path = Path(path)
    _require(path.is_dir(), "AUTH_DIRECTORY_REQUIRED")
    digest = hashlib.sha256(b"bluesai-auth-tree-v1\0")
    count = total = 0

    def visit(at: Path) -> None:
        nonlocal count, total
        _plain(at)
        _require(not (at / ".git").exists(), "GIT_DIRECTORY_FORBIDDEN")
        digest.update(b"D\0" + at.relative_to(path).as_posix().encode("utf-8") + b"\0")
        for item in sorted(at.iterdir(), key=lambda p: p.name):
            _plain(item)
            info = item.stat()
            if stat.S_ISDIR(info.st_mode):
                visit(item)
                continue
            _require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "UNSAFE_AUTH_ENTRY")
            count += 1
            total += info.st_size
            _require(count <= 10000 and total <= 1024 ** 3, "AUTH_LIMIT_EXCEEDED")
            content = hashlib.sha256()
            with item.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    content.update(chunk)
            _require(item.stat().st_size == info.st_size, "AUTH_CHANGED")
            digest.update(b"F\0" + item.relative_to(path).as_posix().encode("utf-8") + b"\0")
            digest.update(str(info.st_size).encode("ascii") + b"\0" + content.digest())

    visit(path)
    return {"count": count, "digest": digest.hexdigest()}


def pid_running(pid: int) -> bool:
    _require(type(pid) is int and 0 < pid <= 0xFFFFFFFF, "INVALID_PID")
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            raise RelinkError("PID_STATE_UNAVAILABLE") from None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel.WaitForSingleObject.restype = ctypes.c_uint32
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE only.
    if not handle:
        _require(ctypes.get_last_error() == 87, "PID_STATE_UNAVAILABLE")
        return False
    try:
        result = kernel.WaitForSingleObject(handle, 0)
        _require(result in (0, 258), "PID_STATE_UNAVAILABLE")
        return result == 258
    finally:
        kernel.CloseHandle(handle)


@contextmanager
def _maintenance(root: Path, expected_pid: int):
    _require(not pid_running(expected_pid), "PROCESS_STILL_RUNNING")
    lock = root / "bridge.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise RelinkError("BRIDGE_LOCK_PRESENT") from None
    marker = str(os.getpid()).encode("ascii")
    owned = os.fstat(descriptor)
    try:
        os.write(descriptor, marker)
        os.fsync(descriptor)
        _require(not pid_running(expected_pid), "PROCESS_STILL_RUNNING")
        yield
    finally:
        os.close(descriptor)
        # Delete only our disposable lock, never auth or an archive.
        if lock.exists():
            current = lock.lstat()
            if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino) and lock.read_bytes() == marker:
                lock.unlink()


def _directory(path: Path, root: Path) -> None:
    if not path.exists():
        path.mkdir(mode=0o700)
    _plain(path)
    _require(path.is_dir() and path.stat().st_dev == root.stat().st_dev, "SAME_FILESYSTEM_REQUIRED")
    _require(not (path / ".git").exists(), "GIT_DIRECTORY_FORBIDDEN")


def _rename(source: Path, target: Path, root: Path) -> None:
    _plain(source)
    _plain(source.parent)
    _plain(target.parent)
    _require(source.resolve().is_relative_to(root) and target.resolve(strict=False).is_relative_to(root),
             "TARGET_OUTSIDE_PRIVATE_DIRECTORY")
    _require(not target.exists() and not target.is_symlink(), "DESTINATION_EXISTS")
    device = root.stat().st_dev
    _require(source.stat().st_dev == target.parent.stat().st_dev == device, "SAME_FILESYSTEM_REQUIRED")
    # bridge.lock excludes other conforming writers; paths are fixed and private.
    os.rename(source, target)


def _read(path: Path) -> dict | None:
    if not path.exists():
        return None
    _plain(path)
    _require(path.is_file() and path.stat().st_size <= 16384, "RECEIPT_INVALID")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        _require(type(value) is dict, "RECEIPT_INVALID")
        return value
    except (ValueError, UnicodeError):
        raise RelinkError("RECEIPT_INVALID") from None


def _write(path: Path, value: dict) -> None:
    old = _read(path)
    if old is not None:
        _require(old == value, "RECEIPT_CONFLICT")
        return
    temporary = path.with_name(".receipt-" + uuid.uuid4().hex)
    try:
        with temporary.open("xb") as stream:
            if os.name != "nt":
                os.chmod(temporary, 0o600)
            stream.write(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        # Hard-link publication is atomic and refuses an existing destination.
        os.link(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()  # Only this process's receipt staging file.


def maintain(action: str, data_dir: str | Path, operation: str, expected_pid: int,
             expected_fingerprint: str, *, reason: str, consent: bool) -> dict:
    _require(action in ("prepare", "restore"), "INVALID_ACTION")
    _require(consent is True and reason == "logged_out", "CONSENT_OR_REASON_REQUIRED")
    _require(type(operation) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", operation), "INVALID_OPERATION")
    _require(type(expected_fingerprint) is str and re.fullmatch(r"[a-f0-9]{64}", expected_fingerprint), "INVALID_FINGERPRINT")
    root = _private_root(data_dir)
    binding = {"version": 1, "operation": operation, "reason": reason, "digest": expected_fingerprint,
               "data_dir_digest": hashlib.sha256(str(root).encode("utf-8")).hexdigest()}
    with _maintenance(root, expected_pid):
        archives = root / "auth-archives"
        _directory(archives, root)
        receipts = archives / "receipts"
        _directory(receipts, root)
        receipt_dir = receipts / operation
        _directory(receipt_dir, root)
        auth, archived = root / "auth", archives / operation
        plan_path = receipt_dir / "prepare.json"
        plan = _read(plan_path)
        if plan is not None:
            _require(plan.get("binding") == binding, "OPERATION_BINDING_MISMATCH")
            _require(type(plan.get("count")) is int, "RECEIPT_INVALID")
        if action == "prepare":
            restored = _read(receipt_dir / "restored.json")
            if restored:
                _require(plan is not None and restored == binding and fingerprint(auth)["digest"] == expected_fingerprint,
                         "RESTORED_STATE_MISMATCH")
                return {"status": "already_restored", "count": plan["count"], "digest": expected_fingerprint}
            if plan is None:
                _require(not archived.exists(), "UNOWNED_ARCHIVE")
                before = fingerprint(auth)
                _require(before["digest"] == expected_fingerprint, "FINGERPRINT_MISMATCH")
                plan = {"binding": binding, "count": before["count"]}
                _write(plan_path, plan)
            if archived.exists():
                _require(fingerprint(archived)["digest"] == expected_fingerprint, "ARCHIVE_MISMATCH")
                status = "already_prepared"
            else:
                _require(fingerprint(auth)["digest"] == expected_fingerprint, "FINGERPRINT_MISMATCH")
                _rename(auth, archived, root)
                status = "prepared"
            _require(fingerprint(archived)["digest"] == expected_fingerprint, "ARCHIVE_MISMATCH")
            _write(receipt_dir / "prepared.json", binding)
            return {"status": status, "count": plan["count"], "digest": expected_fingerprint}

        _require(plan is not None, "PREPARE_RECEIPT_REQUIRED")
        restore_path = receipt_dir / "restore.json"
        restore = _read(restore_path)
        if _read(receipt_dir / "restored.json"):
            _require(_read(receipt_dir / "restored.json") == binding and not archived.exists()
                     and fingerprint(auth)["digest"] == expected_fingerprint, "RESTORED_STATE_MISMATCH")
            return {"status": "already_restored", "count": plan["count"], "digest": expected_fingerprint}
        if restore is None:
            _require(fingerprint(archived)["digest"] == expected_fingerprint, "ARCHIVE_MISMATCH")
            fresh = fingerprint(auth) if auth.exists() else None
            restore = {"binding": binding, "fresh": fresh,
                       "fresh_archive": operation + "-fresh-" + uuid.uuid4().hex if fresh else None}
            _write(restore_path, restore)
        _require(restore.get("binding") == binding, "OPERATION_BINDING_MISMATCH")
        name = restore.get("fresh_archive")
        fresh = restore.get("fresh")
        if fresh is not None:
            _require(type(name) is str and re.fullmatch(re.escape(operation) + r"-fresh-[a-f0-9]{32}", name), "RECEIPT_INVALID")
            preserved = archives / name
            if preserved.exists():
                _require(fingerprint(preserved) == fresh, "FRESH_ARCHIVE_MISMATCH")
            else:
                _require(fingerprint(auth) == fresh, "FRESH_AUTH_CHANGED")
                _rename(auth, preserved, root)
            _require(fingerprint(preserved) == fresh, "FRESH_ARCHIVE_MISMATCH")
        else:
            _require(name is None, "RECEIPT_INVALID")
        if archived.exists():
            _require(fingerprint(archived)["digest"] == expected_fingerprint, "ARCHIVE_MISMATCH")
            _rename(archived, auth, root)
        else:
            # Recover interruption after the final rename, before its receipt.
            _require(fingerprint(auth)["digest"] == expected_fingerprint, "RESTORE_STATE_UNKNOWN")
        _write(receipt_dir / "restored.json", binding)
        return {"status": "restored", "count": plan["count"], "digest": expected_fingerprint}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "restore"))
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--operation", required=True)
    parser.add_argument("--expected-pid", type=int, required=True)
    parser.add_argument("--expected-fingerprint", required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--consent", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = maintain(args.action, args.data_dir, args.operation, args.expected_pid,
                          args.expected_fingerprint, reason=args.reason, consent=args.consent)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except RelinkError as error:
        print(json.dumps({"status": str(error)}))
        return 2
    except OSError:
        print(json.dumps({"status": "FILESYSTEM_OPERATION_FAILED"}))
        return 3


if __name__ == "__main__":
    sys.exit(main())
