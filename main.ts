import {
	App,
	Menu,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	WorkspaceWindow,
	debounce,
	normalizePath,
	setIcon,
} from "obsidian";

const AUDIO_EXTS = new Set(["mp3", "wav", "m4a", "m4b", "ogg", "oga", "opus", "flac", "aac", "webm", "3gp"]);
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

interface AudioDockSettings {
	folder: string;
	includeSubfolders: boolean;
	autoAdvance: boolean;
	takeOverEmbeds: boolean;
	rememberPosition: boolean;
	showOnStartup: boolean;
	skipSeconds: number;
	playbackRate: number;
	volume: number;
	lastFile: string;
	lastTime: number;
}

const DEFAULT_SETTINGS: AudioDockSettings = {
	folder: "",
	includeSubfolders: true,
	autoAdvance: true,
	takeOverEmbeds: true,
	rememberPosition: true,
	showOnStartup: false,
	skipSeconds: 15,
	playbackRate: 1,
	volume: 1,
	lastFile: "",
	lastTime: 0,
};

function isAudio(f: TAbstractFile): f is TFile {
	return f instanceof TFile && AUDIO_EXTS.has(f.extension.toLowerCase());
}

function fmt(sec: number): string {
	if (!isFinite(sec) || sec < 0) sec = 0;
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = Math.floor(sec % 60);
	const mm = h ? String(m).padStart(2, "0") : String(m);
	return (h ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}

export default class AudioDockPlugin extends Plugin {
	settings: AudioDockSettings;

	/** The one and only player. It lives in the main window and is never
	 *  attached to a note, so scrolling / switching notes cannot unload it. */
	audio: HTMLAudioElement;
	playlist: TFile[] = [];
	/** A file played from outside the folder (file menu / embed takeover). */
	extraFile: TFile | null = null;
	current: TFile | null = null;

	dockEl: HTMLElement | null = null;
	dockDoc: Document | null = null;
	private ui: {
		select: HTMLSelectElement;
		playBtn: HTMLElement;
		seek: HTMLInputElement;
		cur: HTMLElement;
		dur: HTMLElement;
		speed: HTMLSelectElement;
	} | null = null;
	private seeking = false;
	private lastSave = 0;

	async onload() {
		await this.loadSettings();

		this.audio = new Audio();
		this.audio.preload = "metadata";
		this.audio.volume = this.settings.volume;
		this.wireAudio();

		this.addSettingTab(new AudioDockSettingTab(this.app, this));

		this.addRibbonIcon("audio-lines", "Toggle Audio Dock", () => this.toggleDock());

		this.addCommand({ id: "toggle-dock", name: "Show/hide dock in this window", callback: () => this.toggleDock() });
		this.addCommand({ id: "play-pause", name: "Play / pause", callback: () => this.togglePlay() });
		this.addCommand({ id: "next", name: "Next file", callback: () => this.step(1) });
		this.addCommand({ id: "previous", name: "Previous file", callback: () => this.step(-1) });
		this.addCommand({ id: "skip-forward", name: "Skip forward", callback: () => this.skip(this.settings.skipSeconds) });
		this.addCommand({ id: "skip-back", name: "Skip back", callback: () => this.skip(-this.settings.skipSeconds) });
		this.addCommand({ id: "rescan", name: "Rescan audio folder", callback: () => this.refreshPlaylist() });

		// Right-click an audio file in the explorer → play it in the dock.
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				if (!isAudio(file)) return;
				menu.addItem((i) =>
					i.setTitle("Play in Audio Dock").setIcon("audio-lines").onClick(() => this.playFile(file, true))
				);
			})
		);

		// Keep the dropdown in sync with the vault.
		const refresh = debounce(() => this.refreshPlaylist(), 500, true);
		this.registerEvent(this.app.vault.on("create", (f) => isAudio(f) && refresh()));
		this.registerEvent(this.app.vault.on("delete", (f) => isAudio(f) && refresh()));
		this.registerEvent(this.app.vault.on("rename", (f) => isAudio(f) && refresh()));

		// Embedded-audio takeover in the main window and any popout windows.
		this.watchEmbeds(document);
		this.registerEvent(
			this.app.workspace.on("window-open", (_w: WorkspaceWindow, win: Window) => this.watchEmbeds(win.document))
		);
		// If the dock's popout window closes, move the dock back to the main window.
		this.registerEvent(
			this.app.workspace.on("window-close", (_w: WorkspaceWindow, win: Window) => {
				if (this.dockDoc === win.document) {
					this.unmountDock();
					this.mountDock(document);
				}
			})
		);

		this.app.workspace.onLayoutReady(() => {
			this.refreshPlaylist();
			if (this.settings.lastFile) {
				const f = this.app.vault.getAbstractFileByPath(this.settings.lastFile);
				if (f && isAudio(f)) this.loadTrack(f, this.settings.rememberPosition ? this.settings.lastTime : 0);
			}
			if (this.settings.showOnStartup) this.mountDock(document);
		});

		this.setupMediaSession();
	}

	onunload() {
		this.savePosition(true);
		this.audio.pause();
		this.audio.removeAttribute("src");
		this.audio.load();
		this.unmountDock();
	}

	// ---------- playlist ----------

	refreshPlaylist() {
		const root = normalizePath(this.settings.folder || "/");
		const folder = root === "/" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(root);
		const out: TFile[] = [];
		if (folder instanceof TFolder) {
			const walk = (f: TFolder) => {
				for (const c of f.children) {
					if (isAudio(c)) out.push(c);
					else if (c instanceof TFolder && this.settings.includeSubfolders) walk(c);
				}
			};
			walk(folder);
		}
		out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
		this.playlist = out;
		if (this.extraFile && out.includes(this.extraFile)) this.extraFile = null;
		this.renderOptions();
	}

	private entries(): TFile[] {
		return this.extraFile ? [this.extraFile, ...this.playlist] : this.playlist;
	}

	private label(f: TFile): string {
		const root = normalizePath(this.settings.folder || "/");
		if (root !== "/" && f.path.startsWith(root + "/")) return f.path.slice(root.length + 1);
		return f.path;
	}

	// ---------- playback ----------

	private loadTrack(file: TFile, startAt = 0) {
		this.current = file;
		if (!this.playlist.includes(file)) this.extraFile = file;
		this.audio.src = this.app.vault.getResourcePath(file);
		this.audio.playbackRate = this.settings.playbackRate;
		if (startAt > 0) {
			const seekOnce = () => {
				this.audio.currentTime = Math.min(startAt, Math.max(0, (this.audio.duration || startAt) - 1));
				this.audio.removeEventListener("loadedmetadata", seekOnce);
			};
			this.audio.addEventListener("loadedmetadata", seekOnce);
		}
		this.settings.lastFile = file.path;
		this.settings.lastTime = startAt;
		this.saveSettings();
		this.renderOptions();
		this.updateMediaMetadata();
	}

	async playFile(file: TFile, showDock = false, startAt = 0) {
		if (this.current?.path !== file.path) this.loadTrack(file, startAt);
		else if (startAt > 0) this.audio.currentTime = startAt;
		if (showDock && !this.dockEl) this.mountDock(activeDocument);
		try {
			await this.audio.play();
		} catch (e) {
			new Notice(`Audio Dock: couldn't play ${file.name}`);
			console.error(e);
		}
	}

	togglePlay() {
		if (!this.current) {
			const first = this.entries()[0];
			if (first) this.playFile(first, true);
			else new Notice("Audio Dock: no audio files found. Check the folder in settings.");
			return;
		}
		if (this.audio.paused) this.audio.play();
		else this.audio.pause();
	}

	step(dir: 1 | -1) {
		const list = this.playlist;
		if (!list.length) return;
		const i = this.current ? list.indexOf(this.current) : -1;
		// Going back within the first 3 s restarts the current file instead.
		if (dir === -1 && this.audio.currentTime > 3 && i >= 0) {
			this.audio.currentTime = 0;
			return;
		}
		const next = list[(i + dir + list.length) % list.length];
		this.playFile(next);
	}

	skip(sec: number) {
		if (!this.current) return;
		const d = this.audio.duration || Infinity;
		this.audio.currentTime = Math.max(0, Math.min(d, this.audio.currentTime + sec));
	}

	private savePosition(force = false) {
		if (!this.settings.rememberPosition || !this.current) return;
		const now = Date.now();
		if (!force && now - this.lastSave < 5000) return;
		this.lastSave = now;
		this.settings.lastTime = this.audio.currentTime;
		this.saveSettings();
	}

	private wireAudio() {
		const a = this.audio;
		a.addEventListener("play", () => this.renderState());
		a.addEventListener("pause", () => {
			this.renderState();
			this.savePosition(true);
		});
		a.addEventListener("loadedmetadata", () => this.renderTime());
		a.addEventListener("timeupdate", () => {
			this.renderTime();
			this.savePosition();
		});
		a.addEventListener("ended", () => {
			this.settings.lastTime = 0;
			this.saveSettings();
			if (this.settings.autoAdvance && this.current && this.playlist.includes(this.current)) {
				const i = this.playlist.indexOf(this.current);
				if (i < this.playlist.length - 1) this.playFile(this.playlist[i + 1]);
			}
		});
		a.addEventListener("error", () => {
			if (this.current) new Notice(`Audio Dock: can't decode ${this.current.name}`);
		});
	}

	// ---------- embedded <audio> takeover ----------

	private watchEmbeds(doc: Document) {
		this.registerDomEvent(
			doc,
			"play",
			(evt: Event) => {
				if (!this.settings.takeOverEmbeds) return;
				const el = evt.target;
				if (!(el instanceof HTMLMediaElement) || el === this.audio || el.tagName !== "AUDIO") return;
				const file = this.fileForEmbed(el);
				if (!file) return;
				const t = el.currentTime;
				el.pause();
				this.playFile(file, true, t);
			},
			true // capture: media "play" events don't bubble
		);
	}

	private fileForEmbed(el: HTMLMediaElement): TFile | null {
		// Obsidian wraps embeds as <span class="internal-embed" src="link">
		const embed = el.closest(".internal-embed, .media-embed") as HTMLElement | null;
		const link = embed?.getAttribute("src");
		if (link) {
			const source = this.app.workspace.getActiveFile()?.path ?? "";
			const f = this.app.metadataCache.getFirstLinkpathDest(link.split("#")[0], source);
			if (f && isAudio(f)) return f;
		}
		// Fallback: match the resource URL against vault files.
		const src = el.currentSrc || el.src;
		if (!src) return null;
		const clean = src.split("?")[0];
		for (const f of this.app.vault.getFiles()) {
			if (isAudio(f) && this.app.vault.getResourcePath(f).split("?")[0] === clean) return f;
		}
		return null;
	}

	// ---------- media keys / OS media controls ----------

	private setupMediaSession() {
		const ms = (navigator as any).mediaSession;
		if (!ms) return;
		const set = (k: string, fn: (d?: any) => void) => {
			try {
				ms.setActionHandler(k, fn);
			} catch (_) {
				/* unsupported action */
			}
		};
		set("play", () => this.audio.play());
		set("pause", () => this.audio.pause());
		set("nexttrack", () => this.step(1));
		set("previoustrack", () => this.step(-1));
		set("seekforward", () => this.skip(this.settings.skipSeconds));
		set("seekbackward", () => this.skip(-this.settings.skipSeconds));
	}

	private updateMediaMetadata() {
		const ms = (navigator as any).mediaSession;
		const MM = (window as any).MediaMetadata;
		if (!ms || !MM || !this.current) return;
		ms.metadata = new MM({ title: this.current.basename, album: this.current.parent?.path ?? "", artist: "Obsidian" });
	}

	// ---------- dock UI ----------

	toggleDock() {
		const doc = activeDocument;
		if (this.dockEl && this.dockDoc === doc) this.unmountDock();
		else {
			this.unmountDock();
			this.mountDock(doc);
		}
	}

	mountDock(doc: Document) {
		if (this.dockEl) return;
		const bar = doc.createElement("div");
		bar.addClass("audio-dock");

		const btn = (icon: string, title: string, fn: () => void) => {
			const b = bar.createEl("button", { cls: "audio-dock-btn clickable-icon", attr: { "aria-label": title } });
			setIcon(b, icon);
			b.addEventListener("click", fn);
			return b;
		};

		const select = bar.createEl("select", { cls: "audio-dock-select dropdown" });
		select.addEventListener("change", () => {
			const f = this.entries()[Number(select.value)];
			if (f) this.playFile(f);
		});
		btn("refresh-cw", "Rescan folder", () => this.refreshPlaylist()).addClass("audio-dock-small");

		const controls = bar.createDiv({ cls: "audio-dock-controls" });
		const cbtn = (icon: string, title: string, fn: () => void) => {
			const b = controls.createEl("button", { cls: "audio-dock-btn clickable-icon", attr: { "aria-label": title } });
			setIcon(b, icon);
			b.addEventListener("click", fn);
			return b;
		};
		cbtn("skip-back", "Previous", () => this.step(-1));
		cbtn("rotate-ccw", `Back ${this.settings.skipSeconds}s`, () => this.skip(-this.settings.skipSeconds));
		const playBtn = cbtn("play", "Play / pause", () => this.togglePlay());
		playBtn.addClass("audio-dock-play");
		cbtn("rotate-cw", `Forward ${this.settings.skipSeconds}s`, () => this.skip(this.settings.skipSeconds));
		cbtn("skip-forward", "Next", () => this.step(1));

		const cur = bar.createSpan({ cls: "audio-dock-time", text: "0:00" });
		const seek = bar.createEl("input", { cls: "audio-dock-seek slider", attr: { type: "range", min: "0", max: "1000", value: "0" } });
		seek.addEventListener("input", () => {
			this.seeking = true;
			cur.setText(fmt((Number(seek.value) / 1000) * (this.audio.duration || 0)));
		});
		seek.addEventListener("change", () => {
			if (this.audio.duration) this.audio.currentTime = (Number(seek.value) / 1000) * this.audio.duration;
			this.seeking = false;
		});
		const dur = bar.createSpan({ cls: "audio-dock-time", text: "0:00" });

		const speed = bar.createEl("select", { cls: "audio-dock-speed dropdown", attr: { "aria-label": "Playback speed" } });
		for (const s of SPEEDS) speed.createEl("option", { text: `${s}×`, value: String(s) });
		speed.value = String(this.settings.playbackRate);
		speed.addEventListener("change", () => {
			this.settings.playbackRate = Number(speed.value);
			this.audio.playbackRate = this.settings.playbackRate;
			this.saveSettings();
		});

		btn("x", "Hide dock (keeps playing)", () => this.unmountDock()).addClass("audio-dock-small");

		this.ui = { select, playBtn, seek, cur, dur, speed };

		// Insert into the window's layout so it takes real space at the bottom
		// instead of covering the editor. Fall back to a fixed overlay.
		const container = doc.querySelector(".app-container") as HTMLElement | null;
		if (container && !Platform.isMobile) {
			container.appendChild(bar);
		} else {
			bar.addClass("audio-dock-fixed");
			doc.body.appendChild(bar);
		}
		doc.body.addClass("audio-dock-visible");

		this.dockEl = bar;
		this.dockDoc = doc;
		this.renderOptions();
		this.renderState();
		this.renderTime();
	}

	unmountDock() {
		this.dockDoc?.body.removeClass("audio-dock-visible");
		this.dockEl?.remove();
		this.dockEl = null;
		this.dockDoc = null;
		this.ui = null;
	}

	private renderOptions() {
		if (!this.ui) return;
		const { select } = this.ui;
		select.empty();
		const list = this.entries();
		if (!list.length) {
			select.createEl("option", { text: "No audio files found", value: "" });
			select.disabled = true;
			return;
		}
		select.disabled = false;
		if (!this.current) select.createEl("option", { text: "Select audio…", value: "" });
		list.forEach((f, i) => {
			const label = f === this.extraFile ? `${f.path} (outside folder)` : this.label(f);
			select.createEl("option", { text: label, value: String(i) });
		});
		select.value = this.current ? String(list.indexOf(this.current)) : "";
	}

	private renderState() {
		if (!this.ui) return;
		setIcon(this.ui.playBtn, this.audio.paused ? "play" : "pause");
		this.dockEl?.toggleClass("is-playing", !this.audio.paused);
	}

	private renderTime() {
		if (!this.ui || this.seeking) return;
		const d = this.audio.duration || 0;
		this.ui.cur.setText(fmt(this.audio.currentTime));
		this.ui.dur.setText(fmt(d));
		this.ui.seek.value = d ? String(Math.round((this.audio.currentTime / d) * 1000)) : "0";
	}

	// ---------- settings ----------

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class AudioDockSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: AudioDockPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = async (rescan = false) => {
			await this.plugin.saveSettings();
			if (rescan) this.plugin.refreshPlaylist();
		};
		containerEl.empty();

		new Setting(containerEl)
			.setName("Audio folder")
			.setDesc("Vault folder to list in the dropdown. Leave empty for the whole vault.")
			.addText((t) => {
				const listId = "audio-dock-folders";
				const dl = containerEl.createEl("datalist", { attr: { id: listId } });
				this.app.vault
					.getAllLoadedFiles()
					.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
					.forEach((f) => dl.createEl("option", { value: f.path }));
				t.inputEl.setAttr("list", listId);
				t.setPlaceholder("e.g. Attachments/Audio")
					.setValue(s.folder)
					.onChange(async (v) => {
						s.folder = v.trim().replace(/^\/+|\/+$/g, "");
						await save(true);
					});
			});

		new Setting(containerEl).setName("Include subfolders").addToggle((t) =>
			t.setValue(s.includeSubfolders).onChange(async (v) => {
				s.includeSubfolders = v;
				await save(true);
			})
		);

		new Setting(containerEl)
			.setName("Take over embedded audio")
			.setDesc("When you press play on an audio embed in a note, play it in the dock instead, so it keeps going while you scroll.")
			.addToggle((t) =>
				t.setValue(s.takeOverEmbeds).onChange(async (v) => {
					s.takeOverEmbeds = v;
					await save();
				})
			);

		new Setting(containerEl).setName("Auto-play next file").addToggle((t) =>
			t.setValue(s.autoAdvance).onChange(async (v) => {
				s.autoAdvance = v;
				await save();
			})
		);

		new Setting(containerEl)
			.setName("Remember position")
			.setDesc("Resume the last file where you left off after restarting Obsidian.")
			.addToggle((t) =>
				t.setValue(s.rememberPosition).onChange(async (v) => {
					s.rememberPosition = v;
					await save();
				})
			);

		new Setting(containerEl).setName("Show dock on startup").addToggle((t) =>
			t.setValue(s.showOnStartup).onChange(async (v) => {
				s.showOnStartup = v;
				await save();
			})
		);

		new Setting(containerEl).setName("Skip interval (seconds)").addSlider((sl) =>
			sl
				.setLimits(5, 60, 5)
				.setValue(s.skipSeconds)
				.setDynamicTooltip()
				.onChange(async (v) => {
					s.skipSeconds = v;
					await save();
				})
		);
	}
}
