"""Bounded, private targeted retry bookkeeping; never moves media itself."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time

MAX_PACKET = 32768
MAX_PENDING = 64
MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000


def _source_key(source):
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:24]


def _safe_source(source):
    return (isinstance(source, str) and bool(source) and len(source.encode("utf-8")) <= 255
            and not re.search(r"[\\/\x00-\x1f\x7f]", source) and not source.startswith((".", "_"))
            and source.lower() != "incomplete")


def _read_packet(file, gid=None):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_PACKET:
            raise ValueError("Invalid retry packet")
        if gid is not None and (info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o660):
            raise ValueError("Retry queue unavailable")
        data = b""
        while len(data) <= MAX_PACKET:
            chunk = os.read(fd, min(4096, MAX_PACKET + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        if len(data) > MAX_PACKET:
            raise ValueError("Invalid retry packet")
        return json.loads(data)
    finally:
        os.close(fd)


class RetrySpool:
    def __init__(self, source_dir, spool_dir, now=None, log=None, shared=None, gid=None, identity=None):
        self.source = Path(source_dir)
        self.spool = Path(spool_dir)
        self.now = now or (lambda: int(time.time() * 1000))
        self.log = log
        self.active = {}
        self.lock = None
        self.shared = os.environ.get("ORGANIZER_RETRY_SHARED") == "1" if shared is None else shared
        if not isinstance(self.shared, bool):
            raise ValueError("Retry queue unavailable")
        self.gid = None
        self.uid, self.groups = identity() if callable(identity) else identity if identity is not None else (
            os.geteuid(), set(os.getgroups()) | {os.getegid()})
        if self.shared:
            configured = os.environ.get("ORGANIZER_RETRY_GID") if gid is None else gid
            if isinstance(configured, bool) or not re.fullmatch(r"[0-9]+", str(configured)):
                raise ValueError("Retry queue unavailable")
            self.gid = int(configured)
            if not 1 <= self.gid <= 0xfffffffe or self.gid not in self.groups:
                raise ValueError("Retry queue unavailable")
            self._check_spool()
        else:
            self.spool.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not stat.S_ISDIR(self.spool.lstat().st_mode):
            raise ValueError("Retry queue unavailable")
        lock_file = self.spool / ".consumer.lock"
        if self.shared:
            try:
                self.lock = os.open(lock_file, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o660)
                self._prepare_created(self.lock)
            except FileExistsError:
                self.lock = os.open(lock_file, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
            except Exception:
                self.close()
                raise
        else:
            self.lock = os.open(lock_file, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            self._check_record(os.fstat(self.lock))
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            os.close(self.lock)
            self.lock = None
            raise
        # Only the lifetime-lock owner can recover claims from a dead watcher.
        try:
            for file in sorted(self.spool.glob("*.claimed.json"))[:MAX_PENDING]:
                if re.fullmatch(r"[a-f0-9]{24}\.claimed\.json", file.name):
                    pending = self.spool / (file.name.removesuffix(".claimed.json") + ".json")
                    completed = self.spool / (file.name.removesuffix(".claimed.json") + ".done.json")
                    if self.shared:
                        try:
                            self._read_packet(file)
                        except (OSError, ValueError, UnicodeError):
                            self._warn_unavailable()
                            continue
                    try:
                        receipt = self._read_packet(completed)
                        if receipt.get("status") in ("attempted", "rejected") and self._read_packet(file).get("requestId") == receipt.get("requestId"):
                            file.unlink()
                            continue
                    except FileNotFoundError:
                        pass
                    except (OSError, ValueError, UnicodeError):
                        if self.shared:
                            self._warn_unavailable()
                            continue
                    if not pending.exists():
                        os.replace(file, pending)
            self._sync()
        except Exception:
            self.close()
            raise

    def _warn_unavailable(self):
        if self.log:
            self.log.warning("[Retry] Queue unavailable; normal imports continue")

    def _check_spool(self, info=None):
        if self.shared:
            info = info or self.spool.lstat()
            if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o2770
                    or info.st_gid != self.gid or info.st_uid not in (0, self.uid)):
                raise ValueError("Retry queue unavailable")

    def _check_record(self, info):
        if (not stat.S_ISREG(info.st_mode) or self.shared and (
                info.st_gid != self.gid or stat.S_IMODE(info.st_mode) != 0o660)):
            raise ValueError("Retry queue unavailable")

    def _prepare_created(self, fd):
        if self.shared:
            if os.fstat(fd).st_gid != self.gid:
                os.fchown(fd, -1, self.gid)
            os.fchmod(fd, 0o660)
            self._check_record(os.fstat(fd))

    def _read_packet(self, file):
        packet = _read_packet(file, self.gid)
        if self.shared and not isinstance(packet, dict):
            raise ValueError("Invalid retry packet")
        return packet

    def _check_claim(self, request):
        if self.shared:
            packet = self._read_packet(request["file"])
            if packet.get("requestId") != request["packet"]["requestId"]:
                raise ValueError("Retry queue unavailable")

    def _sync(self):
        fd = os.open(self.spool, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            self._check_spool(os.fstat(fd))
            os.fsync(fd)
        finally:
            os.close(fd)

    def _valid(self, packet, key):
        if (not isinstance(packet, dict) or packet.get("version") != 1
                or not _safe_source(packet.get("source")) or _source_key(packet["source"]) != key
                or not re.fullmatch(r"[a-f0-9]{32}", str(packet.get("requestId", "")))
                or packet.get("type") not in ("movie", "show") or not isinstance(packet.get("title"), str)
                or len(packet["title"]) > 1000 or isinstance(packet.get("createdAt"), bool)
                or not isinstance(packet.get("createdAt"), (int, float))
                or not self.now() - MAX_AGE_MS <= packet["createdAt"] <= self.now() + 300000):
            return False
        fingerprint = packet.get("fingerprint")
        if not isinstance(fingerprint, dict) or fingerprint.get("kind") not in ("file", "directory"):
            return False
        try:
            if not stat.S_ISDIR(self.source.lstat().st_mode):
                return False
            source = self.source / packet["source"]
            info = source.lstat()
            kind = "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else None
            return (kind == fingerprint["kind"] and str(info.st_dev) == fingerprint.get("device")
                    and str(info.st_ino) == fingerprint.get("inode"))
        except OSError:
            return False

    def _receipt(self, request, status):
        packet = request["packet"]
        record = {"version": 1, "requestId": packet["requestId"], "source": packet["source"],
                  "createdAt": packet["createdAt"], "status": status, "completedAt": self.now()}
        destination = self.spool / (_source_key(packet["source"]) + ".done.json")
        temp = self.spool / ("." + os.urandom(12).hex() + ".tmp")
        try:
            self._check_spool()
            self._check_claim(request)
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o660 if self.shared else 0o600)
            try:
                self._prepare_created(fd)
                data = json.dumps(record, ensure_ascii=False).encode("utf-8")
                written = 0
                while written < len(data):
                    written += os.write(fd, data[written:])
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(temp, destination)
            self._sync()
            request["file"].unlink(missing_ok=True)
            self._sync()
            self._prune_receipts()
            return True
        except (OSError, ValueError, UnicodeError):
            if self.log:
                self.log.warning("[Retry] Receipt unavailable; retry bookkeeping will be retried")
            return False
        finally:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass

    def _prune_receipts(self):
        try:
            receipts = [file for file in self.spool.iterdir() if re.fullmatch(r"[a-f0-9]{24}\.done\.json", file.name)]
            receipts.sort(key=lambda file: file.lstat().st_mtime_ns, reverse=True)
            for file in receipts[128:]:
                file.unlink(missing_ok=True)
        except OSError:
            pass

    def poll(self):
        ready = []
        try:
            self._check_spool()
        except (OSError, ValueError):
            self._warn_unavailable()
            return ready
        for source, request in list(self.active.items()):
            try:
                self._check_claim(request)
            except (OSError, ValueError, UnicodeError):
                self._warn_unavailable()
                continue
            if request.get("finished") and self._receipt(request, "attempted"):
                del self.active[source]
            elif not request.get("finished") and not self._valid(request["packet"], _source_key(source)):
                if self._receipt(request, "rejected"):
                    del self.active[source]
        try:
            files = sorted(file for file in self.spool.iterdir() if re.fullmatch(r"[a-f0-9]{24}\.json", file.name))[:MAX_PENDING]
        except OSError:
            if self.log:
                self.log.warning("[Retry] Queue unavailable; normal imports continue")
            return ready
        for file in files:
            key = file.stem
            claim = self.spool / (key + ".claimed.json")
            try:
                packet = self._read_packet(file)
                # A malformed packet is removed only from this fixed spool;
                # no path from packet contents is used for deletion.
                if not isinstance(packet, dict) or not _safe_source(packet.get("source")) or _source_key(packet["source"]) != key:
                    file.unlink(); self._sync()
                    continue
                if claim.exists():
                    continue
                os.replace(file, claim); self._sync()
                request = {"packet": packet, "file": claim}
                if not self._valid(packet, key):
                    if re.fullmatch(r"[a-f0-9]{32}", str(packet.get("requestId", ""))) and isinstance(packet.get("createdAt"), (int, float)):
                        self._receipt(request, "rejected")
                    else:
                        claim.unlink(); self._sync()
                    continue
                parse_name = Path(packet["source"]).stem if packet["fingerprint"]["kind"] == "file" else packet["source"]
                self.active[packet["source"]] = request
                ready.append({**packet, "parseName": parse_name})
            except (OSError, ValueError, UnicodeError):
                if self.log:
                    self.log.warning("[Retry] Queue request unavailable; other imports continue")
        return ready

    def wants(self, source):
        request = self.active.get(source)
        if not request or request.get("finished"):
            return False
        try:
            self._check_spool()
            self._check_claim(request)
        except (OSError, ValueError, UnicodeError):
            self._warn_unavailable()
            return False
        if self._valid(request["packet"], _source_key(source)):
            return True
        if self._receipt(request, "rejected"):
            del self.active[source]
        return False

    def complete(self, source):
        request = self.active.get(source)
        if request:
            request["finished"] = True
            if self._receipt(request, "attempted"):
                del self.active[source]

    def close(self):
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None
