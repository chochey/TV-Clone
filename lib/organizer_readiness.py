"""Downloader readiness and conservative local-series matching."""
import json,re,time
from pathlib import Path

def ready_for_import(item, snapshot_path, observations, now=None):
    now=time.time() if now is None else now
    try:
        snapshot=json.loads(Path(snapshot_path).read_text())
        if not 0 <= now-snapshot['updatedAt']/1000 <= 45:return False
        name=item.name.casefold();stem=item.stem.casefold()
        matches=[e for e in snapshot['entries'] if any(n.casefold() in (name,stem) for n in e['names'])]
        if any(not e['ready'] for e in matches):
            observations.pop(str(item),None);return False
        # Require unchanged files across two polls, even for manual additions.
        files=[item] if item.is_file() else [p for p in item.rglob('*') if p.is_file()]
        signature=tuple(sorted((str(p),p.stat().st_size,p.stat().st_mtime_ns) for p in files))
        previous=observations.get(str(item))
        if not previous or previous[0]!=signature:
            observations[str(item)]=(signature,now);return False
        return now-previous[1]>=30
    except (OSError,ValueError,KeyError,TypeError):return False

def existing_series(title,year,roots):
    normalize=lambda s:re.sub(r'[^a-z0-9]+',' ',s.casefold()).strip()
    candidates={}
    for root in roots:
        try:folders=Path(root).iterdir()
        except OSError:continue
        for folder in folders:
            match=re.fullmatch(r'(.+) \((\d{4})\)',folder.name)
            if not match or not folder.is_dir() or normalize(match[1])!=normalize(title):continue
            if year and str(year)!=match[2]:continue
            if not any(p.is_file() and re.search(r'S\d+E\d+',p.name,re.I) for p in folder.glob('Season*/*')):continue
            candidates[(normalize(match[1]),match[2])]={'title':match[1],'year':match[2],'type':'series','imdbID':None}
    return next(iter(candidates.values())) if len(candidates)==1 else None
