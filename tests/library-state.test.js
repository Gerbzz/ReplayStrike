const test = require('node:test');
const assert = require('node:assert/strict');
const LibraryState = require('../renderer/library-state.js');

test('edited-only libraries recover to a populated view', () => {
  assert.equal(LibraryState.recoveryView([{ mine: true }]), 'edits');
  assert.equal(LibraryState.recoveryView([{ mine: true }, { mine: false }]), 'all');
});

test('held selection keys cannot toggle a clip twice', () => {
  assert.equal(LibraryState.cardKeyAction({ key: 'Enter', ctrlKey: true, repeat: false }), 'select');
  assert.equal(LibraryState.cardKeyAction({ key: ' ', shiftKey: true, repeat: true }), null);
  assert.equal(LibraryState.cardKeyAction({ key: 'Enter', repeat: false }), 'open');
});

test('card key handler suppresses held Space scrolling and selection repeats', () => {
  const card = {};
  let selections = 0;
  let opens = 0;
  let prevented = 0;
  const event = { target: card, key: ' ', shiftKey: true, repeat: true, preventDefault() { prevented++; } };
  LibraryState.handleCardKeydown(event, card, () => selections++, () => opens++);
  assert.equal(prevented, 1);
  assert.equal(selections, 0);
  assert.equal(opens, 0);
  event.repeat = false;
  LibraryState.handleCardKeydown(event, card, () => selections++, () => opens++);
  assert.equal(prevented, 2);
  assert.equal(selections, 1);
});
