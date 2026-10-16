"""Read-only movie runtime checks. Suspicious sources are held, never deleted."""
import json
import math
import re
import subprocess

def runtime_seconds(value):
    match = re.fullmatch(r'\s*(\d+)\s*min\s*', str(value or ''), re.I)
    return int(match[1]) * 60 if match else None

def assess_duration(actual, expected=None):
    if not actual or not math.isfinite(actual) or actual <= 0:
        return 'Movie runtime could not be verified; source retained for review'
    if expected and expected > 0:
        if actual < expected * 0.5:
            return f'Possible incomplete movie: file is {actual / 60:.1f} min; matched title is about {expected / 60:.0f} min. Source retained'
        if actual >= expected * 0.75:
            return None  # Includes legitimate short films with a matching runtime.
    if actual < 600:
        return f'Possible sample or short film: only {actual / 60:.1f} min. Verify this is the complete movie; source retained'
    return None

def check_movie(source, metadata):
    try:
        result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
            'format=duration:stream=codec_type,duration', '-of', 'json', str(source)],
            capture_output=True, text=True, timeout=20, check=True)
        info = json.loads(result.stdout)
        videos = [s for s in info.get('streams', []) if s.get('codec_type') == 'video']
        if not videos:
            return 'No video stream found; source retained for review'
        durations = []
        for stream in videos:
            try:
                duration = float(stream.get('duration', 0))
                if duration > 0 and math.isfinite(duration): durations.append(duration)
            except (ValueError, TypeError): pass
        actual = max(durations) if durations else float(info.get('format', {}).get('duration', 0))
        return assess_duration(actual, runtime_seconds(metadata.get('runtime')))
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError):
        return 'Could not read movie runtime (damaged file, unfinished download, or probe unavailable); source retained for review'
