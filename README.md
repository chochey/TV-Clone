# Local Stream

A self-hosted media streaming server for your local network. Link your media folders, start the server, and watch from any device — phone, TV, or PC.

## Quick Start

1. **Install and run:**
   ```bash
   npm install && npm start
   ```

2. **Open in a browser** — the server prints your local IP on startup. Visit `http://<your-local-ip>:3000` from any device on your network.

3. **Link your media folders** — go to Media Folders in the sidebar and add paths to your movie and TV show directories. You can link as many folders as you want, each with its own content type.

## Folder Setup

Instead of copying files into a single directory, you point Local Stream at your existing folders:

- **Movies folder** — set type to "Movies" so everything in it is tagged as a movie
- **TV Shows folder** — set type to "TV Shows" so everything is tagged as a show
- **Mixed folder** — set type to "Auto-detect" and it will guess from filenames (looks for S01E01 patterns)

You can link folders from anywhere on the computer. The settings are saved in `config.json`.

## Poster Images

Place poster images in a `posters` subfolder inside any linked media folder, named to match the video filename:

```
/Movies/
  Inception.2010.mp4
  posters/
    Inception.2010.jpg
```

Supports `.jpg`, `.jpeg`, `.png`, and `.webp`.

## Features

- Link multiple folders from anywhere on your system
- Per-folder content type (Movies, TV Shows, or Auto-detect)
- Built-in folder browser for easy setup
- HTTP range request streaming (seeking works)
- Watch progress synced across all devices on the network
- Dark Jellyfin-style responsive UI
- Keyboard shortcuts in the player

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space / K | Play / Pause |
| Left Arrow | Rewind 10s |
| Right Arrow | Forward 10s |
| Up / Down | Volume |
| F | Fullscreen |
| M | Mute |
| Esc | Close player |

## File Structure

```
.
├── server.js          # Express backend
├── index.html         # Frontend UI
├── package.json
├── config.json        # Auto-generated folder config
└── progress.json      # Auto-generated watch progress
```
