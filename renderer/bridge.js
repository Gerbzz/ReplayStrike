// Connects the interface to the Rust backend. Everything the UI needs from
// the system goes through window.replaystrike.
(() => {
  const { invoke, convertFileSrc } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const on = (name, map = (p) => p) => (fn) => listen(name, (e) => fn(map(e.payload)));
  // Thumbnails arrive as file paths; the webview needs a loadable URL.
  const withThumbUrl = (c) => ({ ...c, thumb: c.thumb ? convertFileSrc(c.thumb) : null });

  window.replaystrike = {
    fileUrl: (file) => convertFileSrc(file),
    scan: async () => {
      const result = await invoke('scan');
      result.clips = result.clips.map(withThumbUrl);
      return result;
    },
    addFolder: () => invoke('add_folder'),
    removeFolder: (folder) => invoke('remove_folder', { folder }),
    pickMusic: () => invoke('pick_music'),
    getSettings: () => invoke('get_settings'),
    setSettings: ({ email, password }) => invoke('set_settings', { email, password: password || '' }),
    forgetLogin: () => invoke('forget_login'),
    saveEdit: (edit) => invoke('save_edit', { edit }),
    reveal: (file) => invoke('reveal', { file }),
    copyFile: (file) => invoke('copy_file', { file }),
    trash: (file) => invoke('trash_clip', { file }),
    copyText: (text) => invoke('copy_text', { text }),
    openLink: (url) => invoke('open_link', { url }),
    confirm: (message, action) => invoke('confirm', { message, action }),
    exportClip: (job) => invoke('export_run', { job }),
    uploadStreamable: (job) => invoke('upload_streamable', { job }),
    uploadYouTube: (job) => invoke('upload_youtube', { job }),
    makeReel: (job) => invoke('reel_run', { job }),
    hypeStatus: () => invoke('hype_status'),
    getAnalysis: (file) => invoke('get_analysis', { file }),
    analyze: (job) => invoke('analyze_run', { job }),
    makeMontage: (job) => invoke('montage_run', { job }),
    minimize: () => invoke('win_minimize'),
    toggleMaximize: () => invoke('win_toggle_maximize'),
    close: () => invoke('win_close'),
    onClipUpdate: on('clip:update', withThumbUrl),
    onLibraryChanged: on('library:changed'),
    onJobProgress: on('job:progress'),
  };
})();
