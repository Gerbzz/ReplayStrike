const LibraryState = {
  recoveryView(clips) {
    return clips.some((clip) => !clip.mine) ? 'all' : 'edits';
  },
  handleCardKeydown(event, card, onSelect, onOpen) {
    if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    const action = this.cardKeyAction(event);
    if (action === 'select') onSelect();
    if (action === 'open') onOpen();
  },
  cardKeyAction(event) {
    if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return null;
    return event.ctrlKey || event.shiftKey ? 'select' : 'open';
  },
};

if (typeof module !== 'undefined') module.exports = LibraryState;
