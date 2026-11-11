# Audio Dock for Obsidian

A persistent audio player docked to the bottom of the Obsidian window. Pick any audio file from a folder in a dropdown and it keeps playing while you scroll, switch notes or close the note entirely.

## Why
Obsidian doesn't keep the off-screen parts of a long note drawn. When an embedded `![[recording.mp3]]` scrolls far enough out of view, its `<audio>` element is removed and playback stops. Audio Dock plays everything through one player owned by the plugin, not by the note, so it can't be unloaded that way.

## Features
- Dropdown of every audio file in a chosen folder (optionally including subfolders), kept in sync as files are added, renamed or deleted
- Play/pause, previous/next, skip back/forward (adjustable interval), seek bar, playback speed
- **Embed takeover**: press play on an audio embed in a note and it hands off to the dock, continuing from the same spot
- Right-click an audio file in the file explorer → **Play in Audio Dock**
- Auto-advance to the next file; resumes the last file and position after a restart
- Opens in whichever window you invoke it from (popout windows supported); hiding the dock doesn't stop playback
- OS media keys / media controls (play, pause, next, previous)

Formats: mp3, wav, m4a, m4b, ogg, oga, opus, flac, aac, webm, 3gp.

## Commands
Show/hide dock in this window · Play / pause · Next file · Previous file · Skip forward · Skip back · Rescan audio folder

There's also a ribbon icon to toggle the dock.

## Install
**BRAT:** add `Azurehawke/obsidian-audiodock`.

**Manual:** copy `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/audio-dock/`, then enable **Audio Dock** in Community plugins.

## Build
```
npm install
npm run build
```
Pushing a version tag (e.g. `1.0.0`) runs the GitHub Action that builds and publishes a release.
