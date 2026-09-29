/* 测试桩：在 Node 中加载真实 game.js，返回可控的 __goldMiner 句柄。 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ctxStub = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'canvas') return { width: 960, height: 640 };
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (prop === 'measureText') return () => ({ width: 10 });
    if (typeof prop === 'string') return () => undefined;
    return undefined;
  },
  set() { return true; },
});

function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', className: '', dataset: {}, disabled: false,
    style: { setProperty() {}, removeProperty() {}, transform: '', marginLeft: '', marginTop: '' },
    children: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    querySelectorAll() { return []; },
    getContext() { return ctxStub; },
    clientWidth: 1200, clientHeight: 800,
    focus() {},
  };
}

export function loadGame() {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'game.js'), 'utf8');
  const elements = new Map();
  const getEl = (id) => { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); };

  const sandbox = {
    window: { addEventListener() {}, AudioContext: undefined, webkitAudioContext: undefined },
    document: {
      getElementById: getEl,
      createElement: () => makeEl('created'),
      querySelectorAll: (sel) => sel === '.pw[data-item]'
        ? ['bomb', 'strength', 'luck'].map((k) => Object.assign(makeEl('pw-' + k), { dataset: { item: k } }))
        : [],
      addEventListener() {},
      body: makeEl('body'),
    },
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 1,
    setTimeout: (fn) => globalThis.setTimeout(fn, 0),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    console, Math, Date,
  };
  sandbox.globalThis = sandbox;

  vm.runInContext(source, vm.createContext(sandbox), { filename: 'game.js' });
  const game = sandbox.window.__goldMiner;
  if (!game) throw new Error('__goldMiner 未导出');
  return game;
}
