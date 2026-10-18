// Adding a subtitle file to a film or episode (admins, from the title page).
// The server saves it beside the video and rescans; the page waits until the
// new subtitle is listed on the item.
export const SUBTITLE_LANGUAGES = [
  ['eng', 'English'], ['spa', 'Spanish'], ['fre', 'French'], ['ger', 'German'], ['ita', 'Italian'], ['por', 'Portuguese'],
  ['dut', 'Dutch'], ['swe', 'Swedish'], ['nor', 'Norwegian'], ['dan', 'Danish'], ['fin', 'Finnish'], ['pol', 'Polish'],
  ['rus', 'Russian'], ['gre', 'Greek'], ['tur', 'Turkish'], ['heb', 'Hebrew'], ['ara', 'Arabic'], ['hin', 'Hindi'],
  ['jpn', 'Japanese'], ['kor', 'Korean'], ['chi', 'Chinese'],
].map(([code, label]) => ({ code, label }));

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

export function subtitleFileProblem(file) {
  if (!file) return 'Choose a subtitle file.';
  if (!/\.(srt|vtt)$/i.test(file.name || '')) return 'Use an .srt or .vtt subtitle file.';
  if (!file.size) return 'That file is empty.';
  if (file.size > MAX_SUBTITLE_BYTES) return 'Subtitle files can be up to 2 MB.';
  return '';
}

export async function waitForSubtitle({ load, subtitleId, intervalMs = 2000, timeoutMs = 90000,
  sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
  const until = now() + timeoutMs;
  while (now() <= until) {
    try {
      const item = await load();
      if ((item?.subtitles || []).some(s => s.url === `/subtitle/${subtitleId}`)) return true;
    } catch {}
    await sleep(intervalMs);
  }
  return false;
}
