const LibraryState = {
  recoveryView(clips) {
    return clips.some((clip) => !clip.mine) ? 'all' : 'edits';
  },
  cardKeyAction(event) {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return null;
    return event.ctrlKey || event.shiftKey ? 'select' : 'open';
  },
};

if (typeof module !== 'undefined') module.exports = LibraryState;
