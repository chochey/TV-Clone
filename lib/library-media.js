const path = require('path');
const { detectType } = require('./filename-parse');

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi'];
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.opus'];
const MEDIA_KINDS = new Set(['movie', 'show', 'audio', 'mixed']);
const isAudioFile = file => AUDIO_EXTENSIONS.includes(path.extname(file || '').toLowerCase());

function normalizeFolderMediaKind(folder = {}) {
  if (MEDIA_KINDS.has(folder.mediaKind)) return folder.mediaKind;
  return ['movie', 'show', 'audio'].includes(folder.type) ? folder.type : 'mixed';
}
function extensionsForFolder(folder) {
  const kind = normalizeFolderMediaKind(folder);
  return kind === 'audio' ? AUDIO_EXTENSIONS : kind === 'mixed'
    ? [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] : VIDEO_EXTENSIONS;
}
function classifyMediaKind(file, folder = {}) {
  if (isAudioFile(file)) return 'audio';
  const kind = normalizeFolderMediaKind(folder);
  return kind === 'movie' || kind === 'show' ? kind : detectType(path.basename(file), 'auto');
}

module.exports = { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, MEDIA_KINDS, isAudioFile,
  normalizeFolderMediaKind, extensionsForFolder, classifyMediaKind };
